import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { audit_event, machine, run, token } from '../src/db/schema.ts'
import { runIdleStop } from '../src/sandboxes/idle-stop.ts'
import type { ReadRepository } from '../src/sandboxes/repository-access.ts'
import { setupFailureOf } from '../src/sandboxes/setup-failure.ts'
import { setupCommand } from '../src/sandboxes/workspace.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import {
  approveWaiting,
  createPreview,
  createProject,
  pinPlatform,
  tryCreateMachine,
  waitForMachine,
} from './helpers/seed.ts'

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

const create = (name: string, repository: string, targetId = envId) =>
  tryCreateMachine(h, targetId, {
    name,
    repository,
    repositoryReadable: false,
  })

const setToken = (value: string, projectId = project.id, target = 'preview') =>
  asHuman('PATCH', `/v1/projects/${projectId}/environment-variables`, {
    target,
    set: [
      {
        name: 'GH_TOKEN',
        kind: 'secret',
        value,
      },
    ],
  })

const counts = () => ({
  machines: h.db.select().from(machine).all().length,
  runs: h.db.select().from(run).all().length,
  tokens: h.db.select().from(token).all().length,
})

before(async () => {
  h = await startDispatch({
    readRepository: reader,
  })
  pinPlatform(h, {
    machines: true,
  })
  await startFakeStation(h, 'station-1', {
    machines: {},
  })
  project = await createProject(h, 'alpha')
  envId = (await createPreview(h, 'alpha', 'dev')).id
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

  test('a human stores the token as a secret project environment variable, a deploy token cannot', async () => {
    const minted = await asAdmin('POST', '/v1/tokens', {
      name: 'deployer',
      kind: 'scoped',
      scopes: [
        {
          project_id: project.id,
          target: 'previews',
          level: 'deploy',
        },
      ],
    })
    const refused = await h.call('PATCH', `/v1/projects/${project.id}/environment-variables`, {
      token: minted.body.key,
      body: {
        target: 'preview',
        set: [
          {
            name: 'GH_TOKEN',
            kind: 'secret',
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

  test('a project token set only for production is not read inside a preview', async () => {
    const beta = await createProject(h, 'beta')
    const stored = await approveWaiting(h, await setToken(guarded, beta.id, 'production'))

    assert.equal(stored.status, 200, stored.text)
    const pv = await createPreview(h, 'beta', 'pv')
    const reply = await create('in-preview', privateUrl, pv.id)

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'REPO_ACCESS_REQUIRED')
  })

  test('a repository that is not on github.com is not checked', async () => {
    const before = seen.length
    const reply = await create('elsewhere', 'https://git.example.com/acme/thing')

    assert.equal(reply.status, 201, reply.text)
    assert.equal(seen.length, before)
  })
})

describe('workspace size', () => {
  test('a workspace gets 2 GiB', async () => {
    const workspace = await create('sized', publicUrl)

    assert.equal(workspace.body.size.memory_bytes, 2 * gibibyte)
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
      task_branch: null,
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

describe('idle stop', () => {
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)
  const statuses = () => ({
    reconcile: () => undefined,
  })

  const running = async (name: string) => {
    const made = await create(name, publicUrl)

    await waitForMachine(h, made.body.id, 'running')
    h.db
      .update(machine)
      .set({
        started_at: new Date(Date.now() - 3 * 60 * 60_000),
      })
      .where(eq(machine.id, made.body.id))
      .run()

    return made.body.id as string
  }

  const rowOf = (id: string) => h.db.select().from(machine).where(eq(machine.id, id)).get()!

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
        .some((entry) => entry.action === 'machine.stop' && entry.target.id === id),
    )
  })

  test('recent activity keeps it, and so does turning the setting off', async () => {
    const id = await running('idle-recent')

    h.db
      .update(machine)
      .set({
        started_at: new Date(),
      })
      .where(eq(machine.id, id))
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
      'machine.workspace_idle_stop_s': 0,
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
})
