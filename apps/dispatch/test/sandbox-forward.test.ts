import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'

import { eq } from 'drizzle-orm'
import WebSocket from 'ws'

import { newId } from '../src/db/ids.ts'
import { machine, run, task } from '../src/db/schema.ts'

import {
  addPerson,
  localOrigin,
  mintToken,
  serveOverHttp,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  approveWaiting,
  createProject,
  machineRowOf,
  pinPlatform,
  rows,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let server: Awaited<ReturnType<typeof serveOverHttp>>
let project: any
let taskId: string
let boxId: string
let strangerCookie: string
let deployToken: string

const wsUrl = (path: string) => `${server.url.replace(/^http/, 'ws')}${path}`

type Refusal = { status: number; body: any }

const refused = (path: string, headers: Record<string, string>) =>
  new Promise<Refusal>((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path), {
      headers,
    })

    ws.on('unexpected-response', (_req, res) => {
      let text = ''

      res.on('data', (chunk) => (text += chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(text),
        }),
      )
    })
    ws.on('open', () => {
      ws.close()
      reject(new Error(`${path} was upgraded`))
    })
    ws.on('error', () => undefined)
  })

type Session = {
  ws: WebSocket
  control: any[]
  frames: { channel: number; text: string }[]
  closed: Promise<void>
}

const open = (path: string, headers: Record<string, string>) =>
  new Promise<Session>((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path), {
      headers,
    })
    const control: any[] = []
    const frames: { channel: number; text: string }[] = []
    const closed = new Promise<void>((done) => ws.on('close', () => done()))

    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)

      if (isBinary) {
        frames.push({
          channel: buf[0]!,
          text: buf.subarray(1).toString(),
        })
      } else {
        control.push(JSON.parse(buf.toString()))
      }
    })
    ws.on('open', () =>
      resolve({
        ws,
        control,
        frames,
        closed,
      }),
    )
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused with ${res.statusCode}`)),
    )
    ws.on('error', reject)
  })

const until = async <T>(read: () => T | undefined | false, label: string) => {
  const deadline = Date.now() + 5000

  for (;;) {
    const value = read()

    if (value) {
      return value
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
})

const session = (cookie: string) => ({
  cookie,
  origin: localOrigin,
})

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    ...session(h.admin.cookie),
    body,
  })

const taskRow = (id: string) => h.db.select().from(task).where(eq(task.id, id)).get()!

const setMachineStatus = (id: string, status: 'running' | 'stopped') =>
  h.db
    .update(machine)
    .set({
      status,
    })
    .where(eq(machine.id, id))
    .run()

const openShell = async () => {
  const deadline = Date.now() + 5000

  for (;;) {
    const reply = await asHuman('POST', `/v1/tasks/${taskId}/shells`)

    if (reply.status === 201 || Date.now() > deadline) {
      assert.equal(reply.status, 201, reply.text)

      return reply.body
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const seedMachineRun = (kind: 'shell' | 'exec', exec: { attach: boolean; task_id?: string }) => {
  const id = newId('run')

  h.db
    .insert(run)
    .values({
      id,
      app_id: null,
      machine_id: boxId,
      deployment_id: null,
      kind,
      command: ['true'],
      status: 'queued',
      log_ref: `logs/sandboxes/${boxId}/${id}`,
      tty: kind === 'shell',
      actor: {
        type: 'user',
        id: h.admin.userId,
        client: null,
      },
      exec: {
        cwd: '/root',
        user: null,
        timeout_s: null,
        stdin: null,
        env_keys: [],
        ...exec,
      },
    })
    .run()

  return id
}

const forwardPath = (port: number | string, id = taskId) => `/v1/tasks/${id}/forward?port=${port}`

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {
      interactiveShell: true,
    },
  })
  server = await serveOverHttp(h, {
    attach: true,
  })
  project = await createProject(h, 'alpha')
  mock.method(h.deps.github, 'resolveRepo', () =>
    Promise.resolve({
      auth: 'public' as const,
      default_branch: 'main',
    }),
  )

  const keyed = await approveWaiting(
    h,
    await asHuman('PATCH', `/v1/projects/${project.id}/environment-variables`, {
      target: 'production',
      set: [
        {
          name: 'ANTHROPIC_API_KEY',
          kind: 'secret',
          value: 'sk-ant-test-value',
        },
      ],
    }),
  )

  assert.equal(keyed.status, 200, keyed.text)

  const created = await asHuman('POST', '/v1/tasks', {
    project: 'alpha',
    repository: 'https://github.com/acme/app',
    agent: 'claude',
    prompt: 'Make the button blue',
    isolated: true,
  })

  assert.equal(created.status, 202, created.text)
  taskId = created.body.id
  boxId = taskRow(taskId).machine_id
  await waitForMachine(h, boxId, 'running')
  strangerCookie = (await addPerson(h, 'stranger@example.com', 'admin')).cookie
  deployToken = await mintToken(
    h,
    [
      {
        project_id: project.id,
        target: '*',
        level: 'deploy',
      },
    ],
    'deployer',
  )
})

after(async () => {
  mock.restoreAll()
  await server.close()
  await h.close()
})

describe('the port forward WebSocket', () => {
  test('a request without credentials is 401, a token is HUMAN_REQUIRED and a person who does not own the task is 403', async () => {
    const anonymous = await refused(forwardPath(3000), {})

    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED')

    for (const token of [deployToken, h.admin.token]) {
      const refusal = await refused(forwardPath(3000), bearer(token))

      assert.equal(refusal.status, 403)
      assert.equal(refusal.body.error.code, 'HUMAN_REQUIRED')
      assert.equal(refusal.body.error.details.reason, 'human_required')
    }

    const stranger = await refused(forwardPath(3000), session(strangerCookie))

    assert.equal(stranger.status, 403)
    assert.equal(stranger.body.error.code, 'FORBIDDEN_SCOPE')
  })

  test('an unknown task is 404, a port outside 1 to 65535 is 400 and a stopped machine is 409', async () => {
    const unknown = await refused(
      forwardPath(3000, 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      session(h.admin.cookie),
    )

    assert.equal(unknown.status, 404)

    for (const port of ['0', '70000', 'abc', '']) {
      const bad = await refused(forwardPath(port), session(h.admin.cookie))

      assert.equal(bad.status, 400, port)
      assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
    }

    setMachineStatus(boxId, 'stopped')
    const stopped = await refused(forwardPath(3000), session(h.admin.cookie))

    setMachineStatus(boxId, 'running')
    assert.equal(stopped.status, 409)
    assert.equal(stopped.body.error.code, 'MACHINE_NOT_RUNNING')
    assert.equal(stopped.body.error.details.status, 'stopped')
  })

  test('an accepted forward moves bytes both ways through stationd on the channel-0 frames', async () => {
    const forward = await open(forwardPath(3000), session(h.admin.cookie))
    const ready = await until(
      () => forward.control.find((m) => m.type === 'forwarding'),
      'the forwarding message',
    )

    assert.deepEqual([ready.task_id, ready.port], [taskId, 3000])
    const opened = station.received.find(
      (m) => m.type === 'forward.open' && (m.body as any).sandbox_id === boxId,
    )!.body as any

    assert.deepEqual(
      [opened.sandbox_id, opened.port, opened.service_id, opened.environment_id],
      [boxId, 3000, undefined, undefined],
    )
    assert.equal(rows(h, "select id from audit_event where action = 'task.forward'").length, 1)
    forward.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from('GET / HTTP/1.1')]), {
      binary: true,
    })
    const echoed = await until(
      () => forward.frames.find((f) => f.text === 'GET / HTTP/1.1'.toUpperCase()),
      'the echoed frame',
    )

    assert.equal(echoed.channel, 0)
    assert.deepEqual(
      station.forwarded.find((f) => f.sandbox_id === boxId && f.port === 3000)?.data,
      ['GET / HTTP/1.1'],
    )
    forward.ws.close()
    await forward.closed
    await until(() => station.received.some((m) => m.type === 'stream.cancel'), 'stream.cancel')
  })

  test('a connection stationd cannot make ends the stream with reason connect_failed', async () => {
    const forward = await open(forwardPath(9), session(h.admin.cookie))
    const end = await until(() => forward.control.find((m) => m.type === 'end'), 'the end message')

    assert.equal(end.reason, 'connect_failed')
    await forward.closed
  })

  test('at most 16 forwards are open per machine', async () => {
    const sessions: Session[] = []

    for (let i = 0; i < 16; i++) {
      sessions.push(await open(forwardPath(4000 + i), session(h.admin.cookie)))
    }

    for (const s of sessions) {
      await until(() => s.control.find((m) => m.type === 'forwarding'), 'forwarding')
    }

    const extra = await refused(forwardPath(5000), session(h.admin.cookie))

    assert.equal(extra.status, 429)
    assert.equal(extra.body.error.code, 'RATE_LIMITED')

    for (const s of sessions) {
      s.ws.close()
      await s.closed
    }
  })
})

describe('the attach WebSocket for task shells', () => {
  test('a shell attaches once, only by the task owner, and a second attach is refused', async () => {
    const shell = await openShell()
    const stranger = await refused(`${shell.attach_url}?rows=40&cols=132`, session(strangerCookie))

    assert.equal(stranger.status, 403)
    assert.equal(stranger.body.error.code, 'FORBIDDEN_SCOPE')
    const token = await refused(shell.attach_url, bearer(deployToken))

    assert.equal(token.status, 403)
    assert.equal(token.body.error.code, 'FORBIDDEN_SCOPE')
    const attached = await open(`${shell.attach_url}?rows=40&cols=132`, session(h.admin.cookie))

    await until(() => attached.control.some((m) => m.type === 'attached'), 'the attach')
    const sent = station.received
      .filter((m) => m.type === 'run.start' && (m.body as any).run_id === shell.id)
      .at(-1)!.body as any

    assert.deepEqual(
      [sent.kind, sent.tty, sent.rows, sent.cols, sent.cwd, sent.sandbox_id],
      [
        'shell',
        true,
        40,
        132,
        taskRow(taskId).worktree ?? machineRowOf(h, boxId).workspace!.path,
        boxId,
      ],
    )
    attached.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from('exit\r')]))
    const exit = await until(
      () => attached.control.find((m) => m.type === 'exit'),
      'the exit message',
    )

    assert.deepEqual([exit.run_id, exit.status, exit.exit_code], [shell.id, 'succeeded', 0])
    await attached.closed
    const again = await refused(shell.attach_url, session(h.admin.cookie))

    assert.equal(again.status, 400)
    assert.equal(again.body.error.code, 'VALIDATION_FAILED')
  })

  test('control frames that are not a valid resize or eof are dropped and the shell keeps running', async () => {
    const shell = await openShell()
    const attached = await open(`${shell.attach_url}?rows=24&cols=80`, session(h.admin.cookie))
    const stdin = (text: string) =>
      attached.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(text)]))
    const resizes = () => station.shellResizes.filter((r) => r.run_id === shell.id)

    await until(() => attached.control.some((m) => m.type === 'attached'), 'the attach')

    for (const frame of [
      'null',
      '{not json',
      '{"type":"resize"}',
      '{"type":"resize","rows":30.5,"cols":100}',
      '{"type":"resize","rows":0,"cols":80}',
      '{"type":"resize","rows":50,"cols":160}',
    ]) {
      attached.ws.send(frame)
    }

    await until(() => resizes().length > 0, 'the resize')
    stdin('stty size\r')
    await until(() => attached.frames.some((f) => f.text.includes('50 160')), 'the new window size')
    assert.deepEqual(resizes(), [
      {
        run_id: shell.id,
        rows: 50,
        cols: 160,
      },
    ])
    stdin('exit\r')
    await attached.closed
  })

  test('a machine run that belongs to no task is refused', async () => {
    const reply = await refused(
      `/v1/runs/${seedMachineRun('shell', {
        attach: true,
      })}/attach`,
      session(h.admin.cookie),
    )

    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
  })

  test('a detached exec of a task cannot be attached', async () => {
    const reply = await refused(
      `/v1/runs/${seedMachineRun('exec', {
        attach: false,
        task_id: taskId,
      })}/attach`,
      session(h.admin.cookie),
    )

    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
  })
})
