import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { sandbox } from '../src/db/schema.ts'
import { titleLength } from '../src/sandboxes/agent-sessions.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { createProject, createSandbox, pinPlatform, waitForSandbox } from './helpers/seed.ts'

let h: Dispatch
let project: any
let envId: string
let clock = Date.parse('2026-11-12T10:00:00.000Z')
let counter = 0

const sealed = 'sealed-value-0123456789abcdef'

const api = (method: string, path: string, body?: unknown, token = h.admin.token) =>
  h.call(method, path, {
    token,
    body,
  })

const event = (
  type: string,
  data: Record<string, unknown>,
  session: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `${String(++counter).padStart(8, '0')}-1`,
  type,
  at: new Date((clock += 1000)).toISOString(),
  session_id: session,
  data,
  ...extra,
})

const workspaceOf = async (name: string) => {
  const box = await createSandbox(h, envId, {
    name,
    workspace: {
      agent: 'claude',
      repository: `https://github.com/acme/${name}`,
    },
  })

  await waitForSandbox(h, box.id, 'running')

  const minted = await api('POST', '/v1/tokens', {
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

  return {
    id: box.id as string,
    key: minted.body.key as string,
  }
}

type Workspace = Awaited<ReturnType<typeof workspaceOf>>

const post = async (workspace: Workspace, events: unknown[]) => {
  const reply = await api(
    'POST',
    `/v1/sandboxes/${workspace.id}/agent/events`,
    {
      events,
    },
    workspace.key,
  )

  assert.equal(reply.status, 202, reply.text)
}

const sessions = async (query = '') => {
  const reply = await api('GET', `/v1/agent-sessions${query}`)

  assert.equal(reply.status, 200, reply.text)

  return reply.body as {
    items: any[]
    next_cursor: string | null
  }
}

let dev: Workspace
let docs: Workspace

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
  dev = await workspaceOf('dev')
  docs = await workspaceOf('docs')

  const patched = await api('PATCH', `/v1/sandboxes/${dev.id}/variables`, {
    set: [
      {
        key: 'OWN_SEALED',
        kind: 'sealed',
        value: sealed,
      },
    ],
  })

  assert.equal(patched.status, 200, patched.text)

  await post(dev, [
    event('session.started', {}, 'old'),
    event(
      'prompt',
      {
        text: 'first task',
      },
      'old',
    ),
    event('turn.ended', {}, 'old'),
    event('session.started', {}, 'new'),
    event(
      'prompt',
      {
        text: `  fix\n   the login   redirect with ${sealed}  `,
      },
      'new',
    ),
    event(
      'attention',
      {
        kind: 'permission',
        tool: 'Bash',
        summary: 'rm -rf build',
      },
      'new',
    ),
  ])
  await post(docs, [
    event('session.started', {}, 'docs-1'),
    event(
      'prompt',
      {
        text: 'x'.repeat(titleLength + 50),
      },
      'docs-1',
    ),
    event('turn.ended', {}, 'docs-1'),
  ])
})

after(async () => h.close())

describe('the agent sessions list', () => {
  test('lists every workspace session newest first with project and environment names', async () => {
    const { items, next_cursor } = await sessions()

    assert.equal(next_cursor, null)
    assert.deepEqual(
      items.map((i) => [i.sandbox.name, i.session_id]),
      [
        ['docs', 'docs-1'],
        ['dev', 'new'],
        ['dev', 'old'],
      ],
    )
    assert.equal(items[1].project.name, 'alpha')
    assert.equal(items[1].environment.id, envId)
    assert.equal(items[1].agent, 'claude')
    assert.ok(items[1].started_at < items[1].last_event_at)
  })

  test("a workspace's current session carries its status and kind and an earlier one is ended", async () => {
    const { items } = await sessions()
    const byId = Object.fromEntries(items.map((i) => [i.session_id, i]))

    assert.equal(byId.new.status, 'waiting')
    assert.equal(byId.new.kind, 'permission')
    assert.equal(byId.old.status, 'ended')
    assert.equal(byId.old.kind, null)
    assert.equal(byId['docs-1'].status, 'ready')
    assert.equal(byId['docs-1'].kind, null)
  })

  test('the title is the first prompt, redacted, on one line and cut', async () => {
    const { items } = await sessions()
    const byId = Object.fromEntries(items.map((i) => [i.session_id, i]))

    assert.equal(byId.new.title, 'fix the login redirect with [redacted:OWN_SEALED]')
    assert.equal(byId.old.title, 'first task')
    assert.equal(byId['docs-1'].title.length, titleLength)
  })

  test('filters by status and by workspace', async () => {
    const waiting = await sessions('?status=waiting')

    assert.deepEqual(
      waiting.items.map((i) => i.session_id),
      ['new'],
    )

    const finished = await sessions('?status=ready,ended')

    assert.deepEqual(
      finished.items.map((i) => i.session_id).sort((a, b) => a.localeCompare(b)),
      ['docs-1', 'old'],
    )

    const only = await sessions(`?workspace=${dev.id}`)

    assert.deepEqual(
      only.items.map((i) => i.session_id),
      ['new', 'old'],
    )

    const bad = await api('GET', '/v1/agent-sessions?status=none')

    assert.equal(bad.status, 400)
  })

  test('pages with a cursor', async () => {
    const first = await sessions('?limit=2')

    assert.deepEqual(
      first.items.map((i) => i.session_id),
      ['docs-1', 'new'],
    )
    assert.ok(first.next_cursor)

    const second = await sessions(`?limit=2&cursor=${first.next_cursor}`)

    assert.deepEqual(
      second.items.map((i) => i.session_id),
      ['old'],
    )
    assert.equal(second.next_cursor, null)
  })

  test('needs an instance admin: a workspace token and a read token are refused', async () => {
    const own = await api('GET', '/v1/agent-sessions', undefined, dev.key)

    assert.equal(own.status, 403, own.text)

    const read = await api('POST', '/v1/tokens', {
      name: 'reader',
      kind: 'scoped',
      scopes: [
        {
          project_id: project.id,
          environment_id: envId,
          level: 'read',
        },
      ],
    })
    const refused = await api('GET', '/v1/agent-sessions', undefined, read.body.key)

    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.body.error.code, 'INSTANCE_SCOPE_REQUIRED')
  })
})
