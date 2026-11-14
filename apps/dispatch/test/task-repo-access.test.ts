import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { audit_event, run, sandbox, token } from '../src/db/schema.ts'
import { runIdleStop } from '../src/sandboxes/idle-stop.ts'
import type { ReadRepository } from '../src/sandboxes/repository-access.ts'
import { setupFailureOf } from '../src/sandboxes/setup-failure.ts'
import { setupCommand } from '../src/sandboxes/workspace.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { createProject, createSandbox, pinPlatform, waitForSandbox } from './helpers/seed.ts'

const privateUrl = 'https://github.com/acme/secret'
const publicUrl = 'https://github.com/acme/open'
const guarded = 'ghp_sealed_token_value_0123456789'
const gibibyte = 1024 ** 3

const seen: { repository: string; token: string | null }[] = []

const reader: ReadRepository = (repository, token) => {
  seen.push({
    repository,
    token,
  })

  return Promise.resolve(
    repository === publicUrl
      ? 'readable'
      : repository === privateUrl && token === guarded
        ? 'readable'
        : 'unreadable',
  )
}

let h: Dispatch
let project: any
let envId: string

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const asAdmin = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })

const create = (name: string, repository: string, extra: Record<string, unknown> = {}) =>
  asAdmin('POST', `/v1/environments/${envId}/sandboxes`, {
    name,
    workspace: {
      agent: 'claude',
      repository,
    },
    ...extra,
  })

const setToken = (value: string) =>
  asHuman('PATCH', `/v1/projects/${project.id}/variables`, {
    environment: 'default',
    set: [
      {
        key: 'GH_TOKEN',
        kind: 'sealed',
        value,
      },
    ],
  })

const counts = () => ({
  sandboxes: h.db.select().from(sandbox).all().length,
  runs: h.db.select().from(run).all().length,
  tokens: h.db.select().from(token).all().length,
})

before(async () => {
  h = await startDispatch({
    readRepository: reader,
  })
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

describe('the repository check at workspace create', () => {
  test('a repository that reads anonymously is created without a token', async () => {
    const reply = await create('open-one', publicUrl)

    assert.equal(reply.status, 201, reply.text)
    assert.deepEqual(seen.at(-1), {
      repository: publicUrl,
      token: null,
    })
  })

  test('a private repository with no project token fails REPO_ACCESS_REQUIRED and creates nothing', async () => {
    const before = counts()
    const reply = await create('secret-one', privateUrl)

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'REPO_ACCESS_REQUIRED')
    assert.deepEqual(reply.body.error.details, {
      repository: 'acme/secret',
      project: 'alpha',
    })
    assert.match(reply.body.error.fix, /GH_TOKEN/)
    assert.deepEqual(counts(), before)
  })

  test('a human stores the token as a sealed project variable, a deploy token cannot', async () => {
    const minted = await asAdmin('POST', '/v1/tokens', {
      name: 'deployer',
      kind: 'scoped',
      scopes: [
        {
          project_id: project.id,
          environment_id: envId,
          level: 'deploy',
        },
      ],
    })
    const refused = await h.call('PATCH', `/v1/projects/${project.id}/variables`, {
      token: minted.body.key,
      body: {
        environment: 'default',
        set: [
          {
            key: 'GH_TOKEN',
            kind: 'sealed',
            value: guarded,
          },
        ],
      },
    })

    assert.equal(refused.status, 403, refused.text)

    const stored = await setToken('ghp_a_token_without_access_000000')

    assert.equal(stored.status, 200, stored.text)
  })

  test('a token that cannot read it fails REPO_ACCESS_DENIED, naming the repository and not the token', async () => {
    const before = counts()
    const reply = await create('secret-two', privateUrl)

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'REPO_ACCESS_DENIED')
    assert.equal(
      reply.body.error.explanation,
      "The project's GitHub token cannot read acme/secret.",
    )
    assert.deepEqual(counts(), before)
    assert.equal(reply.text.includes('ghp_a_token_without_access_000000'), false)
  })

  test('a token with access lets the create through, and it is in no audit row', async () => {
    assert.equal((await setToken(guarded)).status, 200)

    const reply = await create('secret-three', privateUrl)

    assert.equal(reply.status, 201, reply.text)
    assert.equal(seen.at(-1)!.token, guarded)
    assert.equal(JSON.stringify(h.db.select().from(audit_event).all()).includes(guarded), false)
  })

  test('a GH_TOKEN in the body counts as the project token', async () => {
    const reply = await create('secret-four', 'https://github.com/acme/other', {
      variables: [
        {
          key: 'GH_TOKEN',
          kind: 'sealed',
          value: guarded,
        },
      ],
    })

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'REPO_ACCESS_DENIED')
    assert.equal(seen.at(-1)!.token, guarded)
  })

  test('a repository that is not on github.com is not checked', async () => {
    const before = seen.length
    const reply = await create('elsewhere', 'https://git.example.com/acme/thing')

    assert.equal(reply.status, 201, reply.text)
    assert.equal(seen.length, before)
  })
})

describe('workspace size', () => {
  test('a workspace gets 2 GiB and a plain sandbox 4 GiB', async () => {
    const workspace = await create('sized', publicUrl)
    const plain = await createSandbox(h, envId, {
      name: 'plain',
    })

    assert.equal(workspace.body.size.memory_bytes, 2 * gibibyte)
    assert.equal(plain.size.memory_bytes, 4 * gibibyte)
  })

  test('the body can still ask for more', async () => {
    const reply = await create('big', publicUrl, {
      size: {
        memory_bytes: 3 * gibibyte,
      },
    })

    assert.equal(reply.body.size.memory_bytes, 3 * gibibyte)
  })
})

describe('setup steps', () => {
  const redact = (text: string) => text.replace('s3cret', '***')
  const failed = (text: string) => ({
    failure: {
      phase: 'run',
      code: 'EXIT_NONZERO',
      summary: 'failed',
      logs: {
        source: 'run',
        untrusted: {
          source: 'run log',
          text,
        },
        truncated: false,
      },
    },
  })

  test('the marker names the step and the tail leaves the marker out and is redacted', () => {
    const found = setupFailureOf(
      failed(
        [
          'Cloning into /workspaces/secret...',
          'fatal: could not read Username for https://github.com s3cret',
          'setup-failed:clone',
        ].join('\n'),
      ) as never,
      redact,
    )

    assert.equal(found.step, 'clone')
    assert.deepEqual(found.tail, [
      'Cloning into /workspaces/secret...',
      'fatal: could not read Username for https://github.com ***',
    ])
  })

  test('no marker means no step, an unknown name means none either, and the tail is five lines', () => {
    const lines = Array.from(
      {
        length: 9,
      },
      (_, index) => `line ${index}`,
    )

    assert.equal(setupFailureOf(failed(lines.join('\n')) as never, redact).step, null)
    assert.equal(setupFailureOf(failed('setup-failed:nonsense') as never, redact).step, null)
    assert.deepEqual(
      setupFailureOf(failed(lines.join('\n')) as never, redact).tail,
      lines.slice(-5),
    )
  })

  test('the script prints the failed step last, whatever the step wrote', () => {
    const bin = mkdtempSync(join(tmpdir(), 'setup-bin-'))
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }

    script('npm', 'exit 0')
    script('gh', 'exit 0')
    script(
      'git',
      'for i in 1 2 3 4 5 6 7 8; do echo "noise $i"; done; echo "fatal: could not read Username" >&2; exit 128',
    )

    const command = setupCommand({
      agent: 'claude',
      repository: privateUrl,
      branch: null,
      path: join(bin, 'clone'),
    })
    const result = spawnSync(command[0]!, command.slice(1), {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GH_TOKEN: 'x',
      },
      encoding: 'utf8',
    })

    assert.equal(result.status, 128)
    assert.equal(result.stderr.trim().split('\n').at(-1), 'setup-failed:clone')
  })
})

describe('failed setup in the session list and the workspace view', () => {
  test('the list carries the step, tail, whole prompt and model, and the workspace says setup failed', async () => {
    const made = await create('broken', publicUrl)

    await waitForSandbox(h, made.body.id, 'running')

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

    const prompt = `${'long '.repeat(60)}end`
    const started = await asHuman('POST', '/v1/agent-sessions', {
      workspace: made.body.id,
      prompt,
      model: 'claude-opus-5-5',
    })

    assert.equal(started.status, 202, started.text)

    const row = h.db.select().from(sandbox).where(eq(sandbox.id, made.body.id)).get()!

    for (
      let waited = 0;
      ['queued', 'running'].includes(
        h.db.select().from(run).where(eq(run.id, row.workspace!.setup_run_id)).get()!.status,
      ) && waited < 100;
      waited += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    h.db
      .update(run)
      .set({
        status: 'failed',
        failure: {
          phase: 'run',
          code: 'EXIT_NONZERO',
          summary: 'failed',
          logs: {
            source: 'run',
            untrusted: {
              source: 'run log',
              text: 'fatal: could not read Username\nsetup-failed:clone',
            },
            truncated: false,
            cursor: null,
          },
        },
        finished_at: new Date(),
      })
      .where(eq(run.id, row.workspace!.setup_run_id))
      .run()

    const list = await asHuman('GET', `/v1/agent-sessions?workspace=${made.body.id}`)
    const item = list.body.items[0]

    assert.equal(item.setup.state, 'failed')
    assert.equal(item.setup.step, 'clone')
    assert.deepEqual(item.setup.tail, ['fatal: could not read Username'])
    assert.equal(item.setup.prompt, prompt)
    assert.equal(item.setup.model, 'claude-opus-5-5')

    const view = await asAdmin('GET', `/v1/sandboxes/${made.body.id}`)

    assert.deepEqual(view.body.workspace.setup, {
      state: 'failed',
      step: 'clone',
    })
  })
})

describe('idle stop', () => {
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)
  const statuses = () => ({
    reconcile: () => undefined,
  })

  const running = async (name: string) => {
    const made = await create(name, publicUrl)

    await waitForSandbox(h, made.body.id, 'running')
    h.db
      .update(sandbox)
      .set({
        started_at: new Date(Date.now() - 3 * 60 * 60_000),
      })
      .where(eq(sandbox.id, made.body.id))
      .run()

    return made.body.id as string
  }

  const rowOf = (id: string) => h.db.select().from(sandbox).where(eq(sandbox.id, id)).get()!

  test('an unused workspace is stopped as idle, keeping its disk and its place in the audit', async () => {
    const id = await running('idle-one')
    const stopped = runIdleStop(
      {
        db: h.db,
        stations: statuses(),
      },
      later(0),
    )

    assert.ok(stopped.includes(id))
    assert.equal(rowOf(id).status, 'stopping')
    assert.equal(rowOf(id).status_reason, 'idle')
    assert.equal(rowOf(id).desired_state, 'stopped')
    assert.ok(
      h.db
        .select()
        .from(audit_event)
        .all()
        .some((entry) => entry.action === 'sandbox.stop' && entry.target.id === id),
    )
  })

  test('a session that is working or waiting never counts as idle', async () => {
    const id = await running('idle-busy')

    for (const status of ['working', 'waiting'] as const) {
      h.db
        .update(sandbox)
        .set({
          agent_status: {
            status,
            since: new Date().toISOString(),
            session_id: 's',
            kind: null,
            agents: [],
            last_event_at: null,
          },
        })
        .where(eq(sandbox.id, id))
        .run()

      assert.equal(
        runIdleStop(
          {
            db: h.db,
            stations: statuses(),
          },
          later(0),
        ).includes(id),
        false,
        status,
      )
    }
  })

  test('recent activity keeps it, and so does turning the setting off', async () => {
    const id = await running('idle-recent')

    h.db
      .update(sandbox)
      .set({
        started_at: new Date(),
      })
      .where(eq(sandbox.id, id))
      .run()

    assert.equal(
      runIdleStop(
        {
          db: h.db,
          stations: statuses(),
        },
        later(5),
      ).includes(id),
      false,
    )

    const off = await asAdmin('PATCH', '/v1/settings', {
      'sandbox.workspace_idle_stop_s': 0,
    })

    assert.equal(off.status, 200, off.text)
    assert.equal(
      runIdleStop(
        {
          db: h.db,
          stations: statuses(),
        },
        later(600),
      ).includes(id),
      false,
    )
  })

  test('a plain sandbox is left to its time to live', async () => {
    const plain = await createSandbox(h, envId, {
      name: 'plain-idle',
    })

    await waitForSandbox(h, plain.id, 'running')
    assert.equal(
      runIdleStop(
        {
          db: h.db,
          stations: statuses(),
        },
        later(600),
      ).includes(plain.id),
      false,
    )
  })
})

describe('replying to a stopped workspace', () => {
  test('starts it and stores the prompt', async () => {
    const made = await create('sleeper', publicUrl)

    await waitForSandbox(h, made.body.id, 'running')

    const started = await asHuman('POST', '/v1/agent-sessions', {
      workspace: made.body.id,
      prompt: 'first',
    })

    assert.equal(started.status, 202, started.text)

    h.db
      .update(sandbox)
      .set({
        status: 'stopped',
        desired_state: 'stopped',
        status_reason: 'idle',
      })
      .where(eq(sandbox.id, made.body.id))
      .run()

    const reply = await asHuman(
      'POST',
      `/v1/sandboxes/${made.body.id}/agent/sessions/${started.body.items?.[0]?.session_id ?? started.body.session_id}/prompts`,
      {
        text: 'second',
      },
    )

    assert.equal(reply.status, 202, reply.text)

    const row = h.db.select().from(sandbox).where(eq(sandbox.id, made.body.id)).get()!

    assert.equal(row.desired_state, 'running')
    assert.equal(row.status_reason, null)
  })
})
