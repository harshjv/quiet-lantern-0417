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
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let projectId: string
let envId: string
let workspaceId: string
let workspaceKey: string
let narrowId: string
let openId: string

const own = workspaceEgress('claude')

const asWorkspace = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: workspaceKey,
    body,
  })

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const refused = (reply: { status: number; text: string; body: any }) => {
  assert.equal(reply.status, 403, reply.text)
  assert.equal(reply.body.error.code, 'HUMAN_REQUIRED')
  assert.equal(reply.body.error.details.reason, 'human_required')
}

const egressOf = async (id: string) =>
  (
    await h.call('GET', `/v1/machines/${id}?fields=*`, {
      token: h.admin.token,
    })
  ).body.egress

let named = 0

const nextName = () => `box-${(named += 1)}`

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

  const workspace = await createMachine(h, envId, {
    name: 'dev',
    workspace: {
      agent: 'claude',
      repository: 'https://github.com/acme/app',
    },
  })

  workspaceId = workspace.id
  await waitForMachine(h, workspaceId, 'running')

  const minted = await h.call('POST', '/v1/tokens', {
    token: h.admin.token,
    body: {
      name: 'workspace-test',
      kind: 'scoped',
      scopes: [
        {
          project_id: project.id,
          target: 'previews',
          level: 'deploy',
        },
      ],
    },
  })

  workspaceKey = minted.body.key

  const row = h.db.select().from(machine).where(eq(machine.id, workspaceId)).get()!

  h.db
    .update(machine)
    .set({
      workspace: {
        ...row.workspace!,
        token_id: minted.body.id,
      },
    })
    .where(eq(machine.id, workspaceId))
    .run()

  narrowId = (
    await createMachine(h, envId, {
      name: 'narrow',
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'example.com',
          },
        ],
      },
    })
  ).id
  openId = (
    await createMachine(h, envId, {
      name: 'open',
    })
  ).id
})

after(async () => h.close())

describe('a workspace token and its own confinement', () => {
  test('widening egress of any machine needs a human actor', async () => {
    const open = {
      egress: {
        mode: 'open',
      },
    }

    refused(await asWorkspace('PATCH', `/v1/machines/${workspaceId}`, open))
    refused(await asWorkspace('PATCH', `/v1/machines/${narrowId}`, open))
    assert.equal((await egressOf(workspaceId)).mode, 'allowlist')

    const reply = await asHuman('PATCH', `/v1/machines/${narrowId}`, open)

    assert.equal(reply.status, 200, reply.text)
    assert.equal((await egressOf(narrowId)).mode, 'open')
  })

  test('adding a domain the machine does not allow needs a human actor', async () => {
    refused(
      await asWorkspace('PATCH', `/v1/machines/${workspaceId}`, {
        egress: {
          mode: 'allowlist',
          domains: [
            ...own.domains,
            {
              domain: 'example.com',
            },
          ],
        },
      }),
    )
  })

  test('joining the network and docker on an update need a human actor', async () => {
    refused(
      await asWorkspace('PATCH', `/v1/machines/${workspaceId}`, {
        network: 'environment',
      }),
    )
    refused(
      await asWorkspace('PATCH', `/v1/machines/${workspaceId}`, {
        docker: true,
      }),
    )
  })

  test('a narrowing change passes', async () => {
    const victim = await createMachine(h, envId, {
      name: nextName(),
      egress: own,
      docker: true,
    })
    const reply = await asWorkspace('PATCH', `/v1/machines/${victim.id}`, {
      egress: {
        mode: 'allowlist',
        domains: [own.domains[0]],
      },
      docker: false,
      network: 'isolated',
    })

    assert.equal(reply.status, 200, reply.text)
    assert.equal((await egressOf(victim.id)).domains.length, 1)
  })

  test('creating a machine with open egress needs a human actor', async () => {
    refused(
      await asWorkspace('POST', placed(h, envId, `machines`), {
        name: nextName(),
        egress: {
          mode: 'open',
        },
      }),
    )

    const reply = await asHuman('POST', placed(h, envId, `machines`), {
      name: nextName(),
      egress: {
        mode: 'open',
      },
    })

    assert.equal(reply.status, 201, reply.text)
  })

  test('creating on the preview network or with docker needs a human actor', async () => {
    refused(
      await asWorkspace('POST', placed(h, envId, `machines`), {
        name: nextName(),
        network: 'environment',
      }),
    )
    refused(
      await asWorkspace('POST', placed(h, envId, `machines`), {
        name: nextName(),
        docker: true,
      }),
    )

    const reply = await asHuman('POST', placed(h, envId, `machines`), {
      name: nextName(),
      network: 'environment',
    })

    assert.equal(reply.status, 201, reply.text)
  })

  test('a create without egress gets the workspace policy, not open', async () => {
    const reply = await asWorkspace('POST', placed(h, envId, `machines`), {
      name: nextName(),
    })

    assert.equal(reply.status, 201, reply.text)
    assert.deepEqual(
      (await egressOf(reply.body.id)).domains.map((entry: { domain: string }) => entry.domain),
      own.domains.map((entry) => entry.domain),
    )
    assert.equal((await egressOf(reply.body.id)).mode, 'allowlist')
  })

  test('a create with a narrower allowlist passes', async () => {
    const reply = await asWorkspace('POST', placed(h, envId, `machines`), {
      name: nextName(),
      egress: {
        mode: 'allowlist',
        domains: [own.domains[0]],
      },
    })

    assert.equal(reply.status, 201, reply.text)
  })

  test('a fork inherits the source policy and needs a human actor when it is wider', async () => {
    refused(
      await asWorkspace('POST', placed(h, envId, `machines`), {
        name: nextName(),
        from: {
          machine: openId,
        },
      }),
    )

    const own = await asWorkspace('POST', placed(h, envId, `machines`), {
      name: nextName(),
      from: {
        machine: workspaceId,
      },
    })

    assert.equal(own.status, 201, own.text)
  })
})

describe('a workspace token running things in machines', () => {
  const exec = {
    command: ['true'],
  }

  test('its own workspace and a narrower isolated machine stay allowed', async () => {
    const narrower = await createMachine(h, envId, {
      name: nextName(),
      egress: {
        mode: 'allowlist',
        domains: [own.domains[0]],
      },
    })

    await waitForMachine(h, narrower.id, 'running')

    for (const id of [workspaceId, narrower.id]) {
      const reply = await asWorkspace('POST', `/v1/machines/${id}/exec`, exec)

      assert.equal(reply.status, 201, reply.text)
    }

    const shell = await asWorkspace('POST', `/v1/machines/${workspaceId}/shells`, {})

    assert.equal(shell.status, 201, shell.text)
  })

  test('a machine with open egress, the preview network or docker needs a human actor', async () => {
    const joined = await createMachine(h, envId, {
      name: nextName(),
      egress: own,
      network: 'environment',
    })
    const docker = await createMachine(h, envId, {
      name: nextName(),
      egress: own,
      docker: true,
    })

    for (const id of [openId, joined.id, docker.id]) {
      refused(await asWorkspace('POST', `/v1/machines/${id}/exec`, exec))
      refused(await asWorkspace('POST', `/v1/machines/${id}/shells`, {}))
    }

    await waitForMachine(h, openId, 'running')

    const reply = await asHuman('POST', `/v1/machines/${openId}/exec`, exec)

    assert.equal(reply.status, 201, reply.text)
  })
})

describe('tokens a machine holds as placeholders', () => {
  let adminWorkspaceId: string

  const deliveredToken = (machineId: string) =>
    station.secrets.filter((s) => s.target.sandbox_id === machineId).at(-1)!.values[
      workspaceEnv.token
    ]!

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
      workspace: {
        agent: 'claude',
        repository: 'https://github.com/acme/app',
        level: 'admin',
      },
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
