import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { agent_input, agent_session, run, sandbox } from '../src/db/schema.ts'
import { startPendingRunners } from '../src/sandboxes/agent-runner.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { createProject, createSandbox, pinPlatform, waitForSandbox } from './helpers/seed.ts'

let h: Dispatch
let project: any
let envId: string
let clock = Date.parse('2026-11-13T10:00:00.000Z')
let counter = 0

const asAdmin = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const asWorkspace = (workspace: Workspace, method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: workspace.key,
    body,
  })

const event = (type: string, data: Record<string, unknown>, session: string) => ({
  id: `${String(++counter).padStart(8, '0')}-1`,
  type,
  at: new Date((clock += 1000)).toISOString(),
  session_id: session,
  data,
})

type Workspace = { id: string; key: string }

const workspaceOf = async (name: string): Promise<Workspace> => {
  const box = await createSandbox(h, envId, {
    name,
    workspace: {
      agent: 'claude',
      repository: `https://github.com/acme/${name}`,
    },
  })

  await waitForSandbox(h, box.id, 'running')

  const minted = await asAdmin('POST', '/v1/tokens', {
    name: `${name}-token`,
    kind: 'scoped',
    scopes: [
      {
        project_id: project.id,
        environment_id: envId,
        level: 'deploy',
      },
    ],
  })

  const row = h.db.select().from(sandbox).where(eq(sandbox.id, box.id)).get()!

  h.db
    .update(sandbox)
    .set({
      workspace: {
        ...row.workspace!,
        token_id: minted.body.id,
      },
    })
    .where(eq(sandbox.id, box.id))
    .run()

  h.db
    .update(run)
    .set({
      status: 'succeeded',
    })
    .where(eq(run.id, row.workspace!.setup_run_id))
    .run()

  return {
    id: box.id,
    key: minted.body.key,
  }
}

const start = (workspace: Workspace, prompt = 'fix the login redirect', extra = {}) =>
  asHuman('POST', '/v1/agent-sessions', {
    workspace: workspace.id,
    prompt,
    ...extra,
  })

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  project = await createProject(h, 'alpha')
  envId = project.default_environment_id
})

after(async () => {
  await h.close()
})

describe('starting a session from the browser', () => {
  let dev: Workspace

  before(async () => {
    dev = await workspaceOf('dev')
  })

  test('a token cannot start one, even a personal one with instance admin', async () => {
    const reply = await asAdmin('POST', '/v1/agent-sessions', {
      workspace: dev.id,
      prompt: 'go',
    })

    assert.equal(reply.status, 403, reply.text)
    assert.equal(reply.body.error.details.reason, 'human_required')
  })

  test('a project without a Claude credential is refused', async () => {
    const reply = await start(dev)

    assert.equal(reply.status, 400, reply.text)
    assert.match(reply.text, /ANTHROPIC_API_KEY/)
  })

  test('with a credential the human starts a session, recorded as its starter, listed at once with its setup state', async () => {
    const set = await asHuman('PATCH', `/v1/projects/${project.id}/variables`, {
      environment: 'default',
      set: [
        {
          key: 'CLAUDE_CODE_OAUTH_TOKEN',
          kind: 'sealed',
          value: 'oauth-token-0123456789abcdef',
        },
      ],
    })

    assert.equal(set.status, 200, set.text)

    const reply = await start(dev, 'fix the login redirect', {
      model: 'claude-opus-5-5',
    })

    assert.equal(reply.status, 202, reply.text)
    assert.equal(reply.body.mode, 'runner')
    assert.equal(reply.body.title, 'fix the login redirect')
    assert.equal(reply.body.started_by.type, 'user')
    assert.equal(reply.body.status, 'working')
    assert.equal(reply.body.setup.state, 'starting')

    const row = h.db
      .select()
      .from(agent_session)
      .where(eq(agent_session.session_id, reply.body.session_id))
      .get()!

    assert.equal(row.model, 'claude-opus-5-5')
    assert.equal(row.started_by.id, h.admin.userId)
  })

  test('a model the agent does not offer is refused', async () => {
    const reply = await start(dev, 'go', {
      model: 'gpt-9',
    })

    assert.equal(reply.status, 400, reply.text)
  })

  test('the runner starts once the workspace is running and set up, as one exec run, and only once', () => {
    const before = h.db.select().from(run).all().length

    startPendingRunners(h.db, () => undefined)
    startPendingRunners(h.db, () => undefined)

    const started = h.db
      .select()
      .from(run)
      .all()
      .filter((candidate) => candidate.command[3] === 'agent-runner')

    assert.equal(h.db.select().from(run).all().length, before + 1)
    assert.equal(started.length, 1)
    assert.deepEqual(started[0]!.command.slice(0, 2), ['bash', '-lc'])
    assert.equal(started[0]!.command[5], 'claude')
    assert.equal(started[0]!.command[6], 'claude-opus-5-5')
    assert.equal(started[0]!.command[7], '')
    assert.equal(started[0]!.command[8], '/workspaces/dev')
  })
})

describe('the inbox, replies and interrupts', () => {
  let ws: Workspace
  let session: string

  before(async () => {
    ws = await workspaceOf('inbox')

    const reply = await start(ws, 'first prompt')

    assert.equal(reply.status, 202, reply.text)
    session = reply.body.session_id
  })

  const inbox = (after = 0) =>
    asWorkspace(ws, 'GET', `/v1/sandboxes/${ws.id}/agent/inbox?session=${session}&after=${after}`)

  test('only the workspace token reads the inbox', async () => {
    assert.equal(
      (await asAdmin('GET', `/v1/sandboxes/${ws.id}/agent/inbox?session=${session}`)).status,
      403,
    )
    assert.equal((await inbox()).status, 200)
  })

  test('the first prompt is delivered, acknowledged once, and not offered again', async () => {
    const first = (await inbox()).body.items

    assert.equal(first.length, 1)
    assert.equal(first[0].kind, 'prompt')
    assert.equal(first[0].text, 'first prompt')

    const acked = await asWorkspace(ws, 'POST', `/v1/sandboxes/${ws.id}/agent/inbox/ack`, {
      ids: [first[0].id],
    })

    assert.equal(acked.status, 202, acked.text)
    assert.equal(acked.body.acked, 1)
    assert.deepEqual((await inbox()).body.items, [])
  })

  test('a prompt that was not acknowledged is offered again', async () => {
    const sent = await asHuman('POST', `/v1/sandboxes/${ws.id}/agent/sessions/${session}/prompts`, {
      text: 'second prompt',
    })

    assert.equal(sent.status, 202, sent.text)
    assert.equal((await inbox()).body.items.length, 1)
    assert.equal((await inbox()).body.items.length, 1)
  })

  test('no token, a workspace token included, can send a prompt into a session', async () => {
    for (const reply of [
      await asAdmin('POST', `/v1/sandboxes/${ws.id}/agent/sessions/${session}/prompts`, {
        text: 'from a personal token',
      }),
      await asWorkspace(ws, 'POST', `/v1/sandboxes/${ws.id}/agent/sessions/${session}/prompts`, {
        text: 'from the agent itself',
      }),
    ]) {
      assert.equal(reply.status, 403, reply.text)
    }

    assert.equal(
      h.db.select().from(agent_input).where(eq(agent_input.sandbox_id, ws.id)).all().length,
      2,
    )
  })

  test('a reply to a session whose runner is not live asks for a runner with resume', async () => {
    h.db
      .update(agent_session)
      .set({
        runner_wanted: false,
        resume: false,
        runner_seen_at: new Date(Date.now() - 120_000),
      })
      .where(eq(agent_session.session_id, session))
      .run()
    await asHuman('POST', `/v1/sandboxes/${ws.id}/agent/sessions/${session}/prompts`, {
      text: 'third prompt',
    })

    const row = h.db
      .select()
      .from(agent_session)
      .where(eq(agent_session.session_id, session))
      .get()!

    assert.equal(row.runner_wanted, true)
    assert.equal(row.resume, true)
  })

  test('a live runner is not asked to restart, and an interrupt needs one', async () => {
    h.db
      .update(agent_session)
      .set({
        runner_seen_at: null,
      })
      .where(eq(agent_session.session_id, session))
      .run()

    const refused = await asHuman(
      'POST',
      `/v1/sandboxes/${ws.id}/agent/sessions/${session}/interrupt`,
    )

    assert.equal(refused.status, 400, refused.text)

    await inbox()
    h.db
      .update(agent_session)
      .set({
        runner_wanted: false,
      })
      .where(eq(agent_session.session_id, session))
      .run()
    await asHuman('POST', `/v1/sandboxes/${ws.id}/agent/sessions/${session}/prompts`, {
      text: 'fourth prompt',
    })
    assert.equal(
      h.db.select().from(agent_session).where(eq(agent_session.session_id, session)).get()!
        .runner_wanted,
      false,
    )

    const accepted = await asHuman(
      'POST',
      `/v1/sandboxes/${ws.id}/agent/sessions/${session}/interrupt`,
    )

    assert.equal(accepted.status, 202, accepted.text)

    const kinds = (await inbox(3)).body.items.map((item: { kind: string }) => item.kind)

    assert.ok(kinds.includes('interrupt'))
  })

  test('a session Stationly did not start takes no prompt', async () => {
    const reply = await asHuman(
      'POST',
      `/v1/sandboxes/${ws.id}/agent/sessions/not-a-session/prompts`,
      {
        text: 'hello',
      },
    )

    assert.equal(reply.status, 400, reply.text)
  })
})

describe('events of a runner session', () => {
  let ws: Workspace
  let session: string

  before(async () => {
    ws = await workspaceOf('events')
    session = (await start(ws, 'list the files')).body.session_id
  })

  test('a permission request is stored as a denied call and never waits on the operator', async () => {
    const posted = await asWorkspace(ws, 'POST', `/v1/sandboxes/${ws.id}/agent/events`, {
      events: [
        event('session.started', {}, session),
        event(
          'attention',
          {
            kind: 'permission',
            tool: 'Bash',
            summary: 'rm -rf build',
          },
          session,
        ),
      ],
    })

    assert.equal(posted.status, 202, posted.text)

    const events = await asAdmin('GET', `/v1/sandboxes/${ws.id}/agent/events?session=${session}`)
    const denied = events.body.items.find((item: { type: string }) => item.type === 'tool.denied')

    assert.deepEqual(denied.data, {
      tool: 'Bash',
      summary: 'rm -rf build',
    })
    assert.equal(
      events.body.items.some((item: { type: string }) => item.type === 'attention'),
      false,
    )

    const sessions = await asAdmin('GET', `/v1/agent-sessions?workspace=${ws.id}`)

    assert.equal(sessions.body.items[0].status, 'working')
  })

  test('a prompt event of a delivered input carries who sent it', async () => {
    const [input] = h.db.select().from(agent_input).where(eq(agent_input.session_id, session)).all()

    h.db
      .update(agent_input)
      .set({
        delivered_at: new Date(),
      })
      .where(eq(agent_input.id, input!.id))
      .run()
    await asWorkspace(ws, 'POST', `/v1/sandboxes/${ws.id}/agent/events`, {
      events: [
        event(
          'prompt',
          {
            text: 'list the files',
          },
          session,
        ),
      ],
    })

    const events = await asAdmin('GET', `/v1/sandboxes/${ws.id}/agent/events?session=${session}`)
    const prompt = events.body.items.find((item: { type: string }) => item.type === 'prompt')

    assert.equal(prompt.data.by.id, h.admin.userId)
    assert.equal(
      h.db.select().from(agent_input).where(eq(agent_input.id, input!.id)).get()!.event_seq,
      prompt.seq,
    )
  })

  test('a prompt typed in a terminal has no sender', async () => {
    await asWorkspace(ws, 'POST', `/v1/sandboxes/${ws.id}/agent/events`, {
      events: [
        event(
          'prompt',
          {
            text: 'typed by hand',
          },
          session,
        ),
      ],
    })

    const events = await asAdmin('GET', `/v1/sandboxes/${ws.id}/agent/events?session=${session}`)
    const typed = events.body.items.find(
      (item: { type: string; data: { text?: string } }) =>
        item.type === 'prompt' && item.data.text === 'typed by hand',
    )

    assert.equal(typed.data.by, undefined)
  })
})
