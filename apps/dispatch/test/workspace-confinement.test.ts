import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { workspaceEgress, workspaceEnv } from '@stationly/protocol'

import { machine } from '../src/db/schema.ts'
import { egressWithin } from '../src/sandboxes/confinement.ts'
import { machineUserFor } from '../src/tasks/machine.ts'
import { memberToken } from '../src/team/keys.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  createMachine,
  createPreview,
  createProject,
  pinPlatform,
  placed,
  tryCreateMachine,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let projectId: string
let envId: string
let workspaceId: string
let workspaceKey: string

let named = 0

const nextName = () => `box-${(named += 1)}`

const deliveredToken = (machineId: string) =>
  station.secrets.filter((s) => s.target.sandbox_id === machineId).at(-1)!.values[
    workspaceEnv.token
  ]!

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {},
  })
  const project = await createProject(h, 'alpha')

  projectId = project.id

  envId = (await createPreview(h, 'alpha', 'dev')).id

  workspaceId = (
    await createMachine(h, envId, {
      name: 'dev',
      agent: 'claude',
      level: 'admin',
    })
  ).id
  await waitForMachine(h, workspaceId, 'running')
  workspaceKey = deliveredToken(workspaceId)
})

after(async () => h.close())

describe('a workspace token creating machines', () => {
  test('a machine whose agent policy is wider than its own needs a human actor', async () => {
    const reply = await tryCreateMachine(h, envId, {
      name: nextName(),
      agent: 'codex',
      token: workspaceKey,
    })

    assert.equal(reply.status, 403, reply.text)
    assert.equal(reply.body.error.code, 'HUMAN_REQUIRED')
    assert.equal(reply.body.error.details.reason, 'human_required')
    assert.equal(reply.body.error.details.required.workspace_id, workspaceId)

    const byHuman = await tryCreateMachine(h, envId, {
      name: nextName(),
      agent: 'codex',
      human: true,
    })

    assert.equal(byHuman.status, 201, byHuman.text)
  })

  test('a machine with the same policy passes and gets the workspace policy', async () => {
    const reply = await tryCreateMachine(h, envId, {
      name: nextName(),
      agent: 'claude',
      token: workspaceKey,
    })

    assert.equal(reply.status, 201, reply.text)
    const row = h.db.select().from(machine).where(eq(machine.id, reply.body.id)).get()!

    assert.equal(row.egress.mode, 'allowlist')
    assert.deepEqual(
      row.egress.domains.map((entry) => entry.domain),
      workspaceEgress('claude').domains.map((entry) => entry.domain),
    )
  })
})

describe('tokens a machine holds as placeholders', () => {
  let adminWorkspaceId: string

  const memberMachineToken = async (machineId: string) => {
    const box = h.db.select().from(machine).where(eq(machine.id, machineId)).get()!

    return memberToken(h.deps.keyring, await machineUserFor(h.db, h.deps, box, h.admin.userId))!
  }

  const createToken = (credential: { token?: string; cookie?: string; origin?: string }) =>
    h.call('POST', '/v1/tokens', {
      ...credential,
      body: {
        name: nextName(),
        kind: 'scoped',
        scopes: [
          {
            project_id: projectId,
            target: 'previews',
            level: 'read',
          },
        ],
      },
    })

  const refusedAsMachineHeld = (reply: { status: number; text: string; body: any }) => {
    assert.equal(reply.status, 403, reply.text)
    assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal(reply.body.error.details.reason, 'machine_held')
    assert.equal(reply.body.key, undefined)
  }

  before(async () => {
    const box = await createMachine(h, envId, {
      name: nextName(),
      level: 'admin',
    })

    adminWorkspaceId = box.id
    await waitForMachine(h, adminWorkspaceId, 'running')
  })

  test('an admin workspace token cannot create a token', async () => {
    refusedAsMachineHeld(
      await createToken({
        token: deliveredToken(adminWorkspaceId),
      }),
    )
  })

  test('a member machine token cannot create a token', async () => {
    refusedAsMachineHeld(
      await createToken({
        token: await memberMachineToken(adminWorkspaceId),
      }),
    )
  })

  test('a workspace token gets no key from the auth server either', async () => {
    const reply = await h.call('POST', '/auth/api-key/create', {
      token: deliveredToken(adminWorkspaceId),
      origin: localOrigin,
      body: {
        name: 'escape',
      },
    })

    assert.ok(reply.status >= 400 && reply.status < 500, reply.text)
    assert.equal(reply.body?.key, undefined)
  })

  test('a person still creates tokens with a session and with a personal token', async () => {
    const bySession = await createToken({
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.equal(bySession.status, 201, bySession.text)
    assert.match(bySession.body.key, /^sly_/)

    const byPersonal = await createToken({
      token: h.admin.token,
    })

    assert.equal(byPersonal.status, 201, byPersonal.text)
    assert.match(byPersonal.body.key, /^sly_/)
  })

  test('a machine token for a machine in a preview covers that preview only', async () => {
    const other = (await createPreview(h, 'alpha', 'other')).id
    const token = await memberMachineToken(adminWorkspaceId)
    const own = await h.call('GET', placed(h, envId, 'apps'), {
      token,
    })

    assert.equal(own.status, 200, own.text)

    const elsewhere = await h.call('GET', placed(h, other, 'apps'), {
      token,
    })

    assert.equal(elsewhere.status, 403, elsewhere.text)
    assert.equal(elsewhere.body.error.code, 'FORBIDDEN_SCOPE')
  })
})

describe('egress comparison', () => {
  const entry = (domain: string, wildcard = false, ports = [443]) => ({
    domain,
    wildcard,
    ports,
  })
  const list = (...domains: ReturnType<typeof entry>[]) => ({
    mode: 'allowlist' as const,
    domains,
  })

  test('open is wider than any list and nothing is wider than open', () => {
    const open = {
      mode: 'open' as const,
      domains: [],
    }

    assert.equal(egressWithin(list(), open), true)
    assert.equal(egressWithin(open, list()), false)
  })

  test('ports and wildcards must be covered', () => {
    assert.equal(egressWithin(list(entry('a.com', false, [22])), list(entry('a.com'))), false)
    assert.equal(egressWithin(list(entry('a.com')), list(entry('a.com', false, [443, 22]))), true)
    assert.equal(egressWithin(list(entry('a.com', true)), list(entry('a.com'))), false)
    assert.equal(egressWithin(list(entry('x.a.com')), list(entry('a.com', true))), true)
    assert.equal(egressWithin(list(entry('w.x.y.z.a.com')), list(entry('a.com', true))), false)
    assert.equal(egressWithin(list(entry('x.a.com', true)), list(entry('a.com', true))), false)
    assert.equal(egressWithin(list(entry('a.com')), list(entry('a.com', true))), false)
  })
})
