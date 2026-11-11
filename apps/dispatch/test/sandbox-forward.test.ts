import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import WebSocket from 'ws'

import {
  localOrigin,
  mintToken,
  serveOverHttp,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  createEnvironment,
  createProject,
  createSandbox,
  pinPlatform,
  waitForSandbox,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let server: Awaited<ReturnType<typeof serveOverHttp>>
let project: any
let envId: string
let lockedId: string
let boxId: string
let deployToken: string
let otherDeployToken: string
let readToken: string

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

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  station = await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  server = await serveOverHttp(h, {
    attach: true,
  })
  project = await createProject(h, 'alpha')
  envId = project.default_environment_id
  lockedId = (
    await createEnvironment(
      h,
      'alpha',
      'locked',
      {
        protected: true,
      },
      true,
    )
  ).id
  boxId = (
    await createSandbox(h, envId, {
      name: 'previewable',
    })
  ).id
  await waitForSandbox(h, boxId, 'running')
  deployToken = await mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: '*',
        level: 'deploy',
      },
    ],
    'deployer',
  )
  otherDeployToken = await mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: '*',
        level: 'deploy',
      },
    ],
    'other-deployer',
  )
  readToken = await mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: '*',
        level: 'read',
      },
    ],
    'reader',
  )
})

after(async () => {
  await server.close()
  await h.close()
})

describe('the port forward WebSocket', () => {
  test('a request without credentials is 401 and read access is 403', async () => {
    const anonymous = await refused(`/v1/sandboxes/${boxId}/forward?port=3000`, {})

    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED')
    const reader = await refused(`/v1/sandboxes/${boxId}/forward?port=3000`, bearer(readToken))

    assert.equal(reader.status, 403)
    assert.equal(reader.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal(reader.body.error.details.required.level, 'deploy')
  })

  test('an unknown sandbox is 404, a port outside 1 to 65535 is 400 and a stopped sandbox is 409', async () => {
    const unknown = await refused(
      '/v1/sandboxes/sbx_01ARZ3NDEKTSV4RRFFQ69G5FAV/forward?port=3000',
      bearer(deployToken),
    )

    assert.equal(unknown.status, 404)

    for (const port of ['0', '70000', 'abc', '']) {
      const bad = await refused(`/v1/sandboxes/${boxId}/forward?port=${port}`, bearer(deployToken))

      assert.equal(bad.status, 400, port)
      assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
    }

    const cold = await createSandbox(h, envId, {
      name: 'cold-forward',
      start: false,
    })
    const stopped = await refused(`/v1/sandboxes/${cold.id}/forward?port=3000`, bearer(deployToken))

    assert.equal(stopped.status, 409)
    assert.equal(stopped.body.error.code, 'SANDBOX_NOT_RUNNING')
    assert.match(stopped.body.error.fix, /start_sandbox/)
  })

  test('in a protected environment a token is refused and a human session is accepted', async () => {
    const locked = await h.call('POST', `/v1/environments/${lockedId}/sandboxes`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        name: 'locked-forward',
      },
    })

    assert.equal(locked.status, 201, locked.text)
    await waitForSandbox(h, locked.body.id, 'running')
    const token = await refused(
      `/v1/sandboxes/${locked.body.id}/forward?port=8080`,
      bearer(h.admin.token),
    )

    assert.equal(token.status, 403)
    assert.equal(token.body.error.code, 'PROTECTED_ENVIRONMENT')
    assert.equal(token.body.error.details.reason, 'human_required')
    const session = await open(`/v1/sandboxes/${locked.body.id}/forward?port=8080`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    await until(
      () => session.control.find((m) => m.type === 'forwarding'),
      'the forwarding message',
    )
    session.ws.close()
    await session.closed
  })

  test('an accepted forward moves bytes both ways through stationd on the channel-0 frames', async () => {
    const session = await open(`/v1/sandboxes/${boxId}/forward?port=3000`, bearer(deployToken))
    const ready = await until(
      () => session.control.find((m) => m.type === 'forwarding'),
      'the forwarding message',
    )

    assert.deepEqual([ready.sandbox_id, ready.port], [boxId, 3000])
    const opened = station.received.find(
      (m) => m.type === 'forward.open' && (m.body as any).sandbox_id === boxId,
    )!.body as any

    assert.deepEqual(
      [opened.sandbox_id, opened.port, opened.service_id, opened.environment_id],
      [boxId, 3000, undefined, undefined],
    )
    session.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from('GET / HTTP/1.1')]), {
      binary: true,
    })
    const echoed = await until(
      () => session.frames.find((f) => f.text === 'GET / HTTP/1.1'.toUpperCase()),
      'the echoed frame',
    )

    assert.equal(echoed.channel, 0)
    assert.deepEqual(
      station.forwarded.find((f) => f.sandbox_id === boxId && f.port === 3000)?.data,
      ['GET / HTTP/1.1'],
    )
    session.ws.close()
    await session.closed
    await until(() => station.received.some((m) => m.type === 'stream.cancel'), 'stream.cancel')
  })

  test('a connection stationd cannot make ends the stream with reason connect_failed', async () => {
    const session = await open(`/v1/sandboxes/${boxId}/forward?port=9`, bearer(deployToken))
    const end = await until(() => session.control.find((m) => m.type === 'end'), 'the end message')

    assert.equal(end.reason, 'connect_failed')
    await session.closed
  })

  test('at most 16 forwards are open per sandbox', async () => {
    const sessions: Session[] = []

    for (let i = 0; i < 16; i++) {
      sessions.push(
        await open(`/v1/sandboxes/${boxId}/forward?port=${4000 + i}`, bearer(deployToken)),
      )
    }

    for (const s of sessions) {
      await until(() => s.control.find((m) => m.type === 'forwarding'), 'forwarding')
    }

    const extra = await refused(`/v1/sandboxes/${boxId}/forward?port=5000`, bearer(deployToken))

    assert.equal(extra.status, 429)
    assert.equal(extra.body.error.code, 'RATE_LIMITED')

    for (const s of sessions) {
      s.ws.close()
      await s.closed
    }
  })
})

describe('the attach WebSocket for sandbox runs', () => {
  test('an exec created with attach = true streams its output and reports its exit', async () => {
    const created = await h.call('POST', `/v1/sandboxes/${boxId}/exec`, {
      token: deployToken,
      body: {
        command: ['echo', 'attached'],
        attach: true,
      },
    })

    assert.equal(created.status, 201, created.text)
    const session = await open(created.body.attach_url, bearer(deployToken))
    const exit = await until(
      () => session.control.find((m) => m.type === 'exit'),
      'the exit message',
    )

    assert.equal(exit.status, 'succeeded')
    assert.equal(exit.exit_code, 0)
    assert.ok(session.control.some((m) => m.type === 'attached' && m.tty === false))
    assert.equal(session.frames[0]!.channel, 1)
    assert.match(session.frames[0]!.text, /\$ echo attached/)
    const sent = station.received
      .filter((m) => m.type === 'run.start' && (m.body as any).run_id === created.body.id)
      .at(-1)!.body as any

    assert.deepEqual(
      [sent.attach, sent.sandbox_id, sent.service_id, sent.deployment_id, sent.rows, sent.cols],
      [true, boxId, null, null, null, null],
    )
    await session.closed
  })

  test('a shell attaches once, only by the actor that created it, and a second attach is refused', async () => {
    const shell = await h.call('POST', `/v1/sandboxes/${boxId}/shells`, {
      token: deployToken,
      body: {
        cwd: '/root',
      },
    })

    assert.equal(shell.status, 201, shell.text)
    const stranger = await refused(
      `${shell.body.attach_url}?rows=40&cols=132`,
      bearer(otherDeployToken),
    )

    assert.equal(stranger.status, 403)
    assert.equal(stranger.body.error.code, 'FORBIDDEN_SCOPE')
    const reader = await refused(shell.body.attach_url, bearer(readToken))

    assert.equal(reader.status, 403)
    const session = await open(`${shell.body.attach_url}?rows=40&cols=132`, bearer(deployToken))

    await until(() => session.control.find((m) => m.type === 'exit'), 'the shell to end')
    const sent = station.received
      .filter((m) => m.type === 'run.start' && (m.body as any).run_id === shell.body.id)
      .at(-1)!.body as any

    assert.deepEqual(
      [sent.kind, sent.tty, sent.rows, sent.cols, sent.cwd, sent.sandbox_id],
      ['shell', true, 40, 132, '/root', boxId],
    )
    await session.closed
    const again = await refused(shell.body.attach_url, bearer(deployToken))

    assert.equal(again.status, 400)
    assert.equal(again.body.error.code, 'VALIDATION_FAILED')
  })

  test('control frames that are not a valid resize or eof are dropped and the shell keeps running', async () => {
    const interactive = await startFakeStation(h, 'station-2', {
      sandboxes: {
        interactiveShell: true,
      },
    })
    const box = await createSandbox(h, envId, {
      name: 'interactive',
      station_id: 'station-2',
    })

    await waitForSandbox(h, box.id, 'running')
    const shell = await h.call('POST', `/v1/sandboxes/${box.id}/shells`, {
      token: deployToken,
      body: {},
    })

    assert.equal(shell.status, 201, shell.text)
    const session = await open(`${shell.body.attach_url}?rows=24&cols=80`, bearer(deployToken))
    const stdin = (text: string) =>
      session.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(text)]))
    const resizes = () => interactive.shellResizes.filter((r) => r.run_id === shell.body.id)

    await until(() => session.control.some((m) => m.type === 'attached'), 'the attach')

    for (const frame of [
      'null',
      '{not json',
      '{"type":"resize"}',
      '{"type":"resize","rows":30.5,"cols":100}',
      '{"type":"resize","rows":0,"cols":80}',
      '{"type":"resize","rows":50,"cols":160}',
    ]) {
      session.ws.send(frame)
    }

    await until(() => resizes().length > 0, 'the resize')
    stdin('stty size\r')
    await until(() => session.frames.some((f) => f.text.includes('50 160')), 'the new window size')
    assert.deepEqual(resizes(), [
      {
        run_id: shell.body.id,
        rows: 50,
        cols: 160,
      },
    ])
    stdin('exit\r')
    await session.closed
  })

  test('a detached exec cannot be attached', async () => {
    const detached = await h.call('POST', `/v1/sandboxes/${boxId}/exec`, {
      token: deployToken,
      body: {
        command: ['true'],
        wait_s: 5,
      },
    })
    const reply = await refused(`/v1/runs/${detached.body.id}/attach`, bearer(deployToken))

    assert.equal(reply.status, 400)
  })
})
