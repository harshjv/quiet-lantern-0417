import { and, eq } from 'drizzle-orm'

import { releaseRepositories } from '@stationly/protocol/release-config'

import { app, approval, setting, target, task, type ApprovalShip } from '../../src/db/schema.ts'
import { lockfileFor, parseManifest, sha256Of, storeRelease } from '../../src/platform/lockfile.ts'

import type { Dispatch } from './dispatch.ts'

type Api = Pick<Dispatch, 'call' | 'admin' | 'db'>

const must = <T>(reply: { status: number; body: T; text: string }, ...ok: number[]) => {
  if (!ok.includes(reply.status)) {
    throw new Error(`seed call answered ${reply.status}: ${reply.text}`)
  }

  return reply.body
}

export const createProject = async (h: Api, name = 'shop') =>
  must<any>(
    await h.call('POST', '/v1/projects', {
      token: h.admin.token,
      body: {
        name,
      },
    }),
    201,
  )

export const productionId = (h: Pick<Dispatch, 'db'>, projectId: string) =>
  h.db
    .select()
    .from(target)
    .where(and(eq(target.project_id, projectId), eq(target.kind, 'production')))
    .get()!.id

export const placed = (h: Pick<Dispatch, 'db'>, targetId: string, rest: string) => {
  const row = h.db.select().from(target).where(eq(target.id, targetId)).get()!
  const path = `/v1/projects/${row.project_id}/${rest}`

  if (row.kind === 'production') {
    return path
  }

  return `${path}${path.includes('?') ? '&' : '?'}preview=${row.id}`
}

export const approveWaiting = async (
  h: Api,
  reply: { status: number; body: any; text: string },
) => {
  if (reply.status !== 202) {
    return reply
  }

  const decided = await h.call('POST', `/v1/approvals/${reply.body.id}/decision`, {
    cookie: h.admin.cookie,
    origin: 'http://127.0.0.1:7900',
    body: {
      decision: 'approve',
    },
  })

  if (decided.status !== 200) {
    throw new Error(`approving ${reply.body.id} answered ${decided.status}: ${decided.text}`)
  }

  return decided
}

export const createPreview = async (
  h: Api,
  project: string,
  name: string,
  extra: Record<string, unknown> = {},
) =>
  must<any>(
    await h.call('POST', `/v1/projects/${project}/previews`, {
      token: h.admin.token,
      body: {
        name,
        deploy_on_create: false,
        ...extra,
      },
    }),
    201,
  )

export type AppSeed = {
  name: string
  kind?: string
  ref: string
  ports?: { port: number; protocol?: string }[]
  environment_variables?: unknown[]
  deploy?: boolean
  extra?: Record<string, unknown>
}

export const createApp = async (h: Api, targetId: string, seed: AppSeed) => {
  const reply = await h.call('POST', placed(h, targetId, 'apps'), {
    token: h.admin.token,
    body: {
      name: seed.name,
      kind: seed.kind ?? 'web',
      source: {
        type: 'image',
        ref: seed.ref,
      },
      ports: seed.ports,
      environment_variables: seed.environment_variables,
      deploy_on_create: seed.deploy ?? false,
      ...seed.extra,
    },
  })

  if (reply.status !== 202) {
    return must<any>(reply, 201)
  }

  await approveWaiting(h, reply)
  const row = h.db
    .select()
    .from(app)
    .where(and(eq(app.target_id, targetId), eq(app.name, seed.name)))
    .get()!

  return must<any>(
    await h.call('GET', `/v1/apps/${row.id}?fields=*`, {
      token: h.admin.token,
    }),
    200,
  )
}

export const listApps = async (h: Api, targetId: string) =>
  must<any>(
    await h.call('GET', placed(h, targetId, 'apps?fields=*'), {
      token: h.admin.token,
    }),
    200,
  ).items as any[]

export const waitForActive = async (h: Api, appId: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const svc = must<any>(
      await h.call('GET', `/v1/apps/${appId}?fields=current_deployment_id`, {
        token: h.admin.token,
      }),
      200,
    )

    if (svc.current_deployment_id) {
      return svc
    }

    if (Date.now() > deadline) {
      throw new Error(`app ${appId} never became current`)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const seedLockfile = (h: Pick<Dispatch, 'db'>) => {
  const value = {
    schema: 2,
    release: '0.0.0-test',
    channel: 'stable',
    manifest_digest: `sha256:${'0'.repeat(64)}`,
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    overrides: {},
    grype_db: null,
    templates: {},
  }

  h.db
    .insert(setting)
    .values({
      key: 'platform.lockfile',
      value,
      updated_by: {
        type: 'system',
        id: null,
        client: 'test-harness',
      },
    })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
      },
    })
    .run()
}

const digestOf = (c: string) => `sha256:${c.repeat(64)}`

const toolchainDigest = digestOf('e')

const releaseManifest = (release: string, gateway: boolean, machines: boolean) =>
  JSON.stringify({
    schema: 1,
    release,
    channel: 'stable',
    published_at: '2026-11-01T00:00:00Z',
    changelog: '',
    components: {
      dispatch: {
        kind: 'binary',
        version: '0.0.0',
        source: releaseRepositories.dispatch,
        digest: digestOf('d'),
        platforms: null,
      },
      ...(machines
        ? {
            sandbox_toolchain: {
              kind: 'image',
              version: '0.1.0',
              source: releaseRepositories.sandbox_toolchain,
              digest: toolchainDigest,
              platforms: {
                'linux/amd64': digestOf('f'),
                'linux/arm64': digestOf('1'),
              },
            },
          }
        : {}),
      ...(gateway
        ? {
            gateway: {
              kind: 'image',
              version: '3.7.18',
              source: 'docker.io/library/traefik',
              digest: digestOf('a'),
              platforms: {
                'linux/amd64': digestOf('b'),
                'linux/arm64': digestOf('c'),
              },
            },
          }
        : {}),
    },
  })

export const pinPlatform = (
  h: Pick<Dispatch, 'db'>,
  options: { gateway?: boolean; machines?: boolean } = {},
) => {
  const raw = releaseManifest(
    `0.0.0-test${options.gateway ? '-gateway' : ''}${options.machines ? '-machines' : ''}`,
    options.gateway ?? false,
    options.machines ?? false,
  )

  storeRelease(h.db, {
    manifestRaw: raw,
    bundle: '{}',
    source: 'test',
    verifiedBy: 'test',
  })
  const value = lockfileFor(parseManifest(raw), sha256Of(raw))
  const actor = {
    type: 'system',
    id: null,
    client: 'test-harness',
  }
  const existing = h.db.select().from(setting).where(eq(setting.key, 'platform.lockfile')).get()

  if (existing) {
    h.db
      .update(setting)
      .set({
        value,
        updated_by: actor as never,
      })
      .where(eq(setting.key, 'platform.lockfile'))
      .run()
  } else {
    h.db
      .insert(setting)
      .values({
        key: 'platform.lockfile',
        value,
        updated_by: actor as never,
      })
      .run()
  }
}

export const waitForDeployment = async (
  h: Api & Partial<Pick<Dispatch, 'deps'>>,
  deploymentId: string,
  status: string,
  timeoutMs = 8000,
) => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    h.deps?.stations.reconcile()
    const dep = must<any>(
      await h.call('GET', `/v1/deployments/${deploymentId}`, {
        token: h.admin.token,
      }),
      200,
    )

    if (dep.status === status) {
      return dep
    }

    if (Date.now() > deadline) {
      throw new Error(`deployment ${deploymentId} stayed ${dep.status}, wanted ${status}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const rows = <T = Record<string, unknown>>(
  h: Pick<Dispatch, 'db'>,
  sql: string,
  ...params: unknown[]
) =>
  (
    h.db as unknown as { $client: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }
  ).$client
    .prepare(sql)
    .all(...params) as T[]

export const toolchainImageDigest = toolchainDigest

export const createMachine = async (
  h: Api,
  targetId: string,
  body: Record<string, unknown> = {},
  expect = [201],
) =>
  must<any>(
    await h.call('POST', placed(h, targetId, 'machines'), {
      token: h.admin.token,
      body,
    }),
    ...expect,
  )

export const waitForMachine = async (
  h: Api & Partial<Pick<Dispatch, 'deps'>>,
  machineId: string,
  status: string,
  timeoutMs = 8000,
) => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    h.deps?.stations.reconcile()
    const box = must<any>(
      await h.call('GET', `/v1/machines/${machineId}?fields=*`, {
        token: h.admin.token,
      }),
      200,
    )

    if (box.status === status) {
      return box
    }

    if (Date.now() > deadline) {
      throw new Error(`machine ${machineId} stayed ${box.status}, wanted ${status}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const seedTask = (
  h: Pick<Dispatch, 'db'>,
  values: { project_id: string; owner: string; preview_id?: string | null },
) =>
  h.db
    .insert(task)
    .values({
      project_id: values.project_id,
      target_id: productionId(h, values.project_id),
      owner: {
        type: 'user',
        id: values.owner,
      },
      title: 'a task',
      repository: 'https://github.com/acme/web',
      branch: 'task/a-task',
      agent: 'claude',
      machine_id: 'mch_seeded',
      preview_id: values.preview_id ?? null,
    })
    .returning()
    .get()

export const seedShip = (
  h: Pick<Dispatch, 'db'>,
  seeded: { id: string; project_id: string },
  values: {
    requester: string
    status?: 'waiting' | 'approved' | 'rejected'
    ship?: Partial<ApprovalShip>
  },
) =>
  h.db
    .insert(approval)
    .values({
      project_id: seeded.project_id,
      task_id: seeded.id,
      title: 'Ship a task',
      requested_by: {
        type: 'user',
        id: values.requester,
        client: null,
      },
      requester: values.requester,
      changes: [],
      refs: {},
      source: 'task',
      status: values.status ?? 'waiting',
      deployments: [],
      ship: {
        phase: 'open',
        run_id: 'run_seeded',
        pull_request: {
          repo: 'github.com/acme/web',
          number: 7,
          url: 'https://github.com/acme/web/pull/7',
        },
        head_sha: 'a'.repeat(40),
        merge_sha: null,
        reason: null,
        ...values.ship,
      },
    })
    .returning()
    .get()
