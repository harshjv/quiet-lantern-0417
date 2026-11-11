import { localOrigin, mintToken, startFakeStation, type Dispatch } from './dispatch.ts'
import type { FakeStation } from './fake-station.ts'
import type { FakeRegistry } from './registry.ts'
import {
  createEnvironment,
  createProject,
  createSandbox,
  createService,
  rows,
  seedLockfile,
  waitForActive,
  waitForDeployment,
  waitForSandbox,
} from './seed.ts'

export type World = {
  station: FakeStation
  project: { id: string; name: string }
  production: string
  staging: string
  locked: string
  services: Record<string, string>
  sandbox: string
  snapshot: string
  lockedService: string
  scoped: string
  staged: { id: string } | null
}

export const seedWorld = async (h: Dispatch, registry: FakeRegistry): Promise<World> => {
  const token = h.admin.token

  registry.publish('postgres:17')
  registry.publish('nginx:1.27')
  seedLockfile(h)
  const station = await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  const project = await createProject(h, 'shop')
  const production = project.default_environment_id as string
  const staging = (await createEnvironment(h, 'shop', 'staging')).id as string
  const locked = (
    await createEnvironment(
      h,
      'shop',
      'locked',
      {
        protected: true,
      },
      true,
    )
  ).id as string

  const db = await createService(h, production, {
    name: 'db',
    ref: 'postgres:17',
    ports: [
      {
        port: 5432,
        protocol: 'tcp',
      },
    ],
    deploy: true,
    extra: {
      volumes: [
        {
          mount_path: '/var/lib/postgresql/data',
        },
      ],
      strategy: 'replace',
    },
  })
  const web = await createService(h, production, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
    variables: [
      {
        key: 'DATABASE_URL',
        kind: 'reference',
        reference: 'postgres://app@${{db.HOST}}:5432/app',
      },
      {
        key: 'API_KEY',
        kind: 'sealed',
        value: 'hunter2',
      },
      {
        key: 'MODE',
        kind: 'literal',
        value: 'production',
      },
    ],
  })
  const worker = await createService(h, production, {
    name: 'worker',
    kind: 'worker',
    ref: 'nginx:1.27',
    deploy: true,
  })
  const cron = await createService(h, production, {
    name: 'nightly',
    kind: 'cron',
    ref: 'nginx:1.27',
    deploy: false,
    extra: {
      schedule: {
        cron: '0 3 * * *',
        timezone: 'UTC',
        concurrency: 'skip',
      },
    },
  })
  const stagingWeb = await createService(h, staging, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
  })
  const lockedCreate = await h.call('POST', `/v1/environments/${locked}/services`, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body: {
      name: 'api',
      kind: 'web',
      source: {
        type: 'image',
        ref: 'nginx:1.27',
      },
      ports: [
        {
          port: 8080,
        },
      ],
      deploy_on_create: false,
    },
  })
  const accepted = await h.call('POST', `/v1/staged-changes/${lockedCreate.body.id}/accept`, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body: {},
  })

  if (accepted.status !== 200) {
    throw new Error(`could not accept the staged service: ${accepted.text}`)
  }

  const lockedService = {
    id: rows<{ id: string }>(h, 'select id from service where environment_id = ?', locked)[0]!.id,
  }

  for (const created of [db, web, worker, stagingWeb]) {
    await waitForDeployment(h, created.deployments[0].id, 'active')
  }

  await waitForActive(h, db.id)

  const webPort = web.ports[0].id as string

  await h.call('POST', `/v1/ports/${webPort}/domains`, {
    token,
    body: {
      generated: true,
    },
  })
  await h.call('POST', `/v1/ports/${db.ports[0].id}/port-allocations`, {
    token,
    body: {},
  })
  await h.call('PATCH', `/v1/services/${stagingWeb.id}/variables`, {
    token,
    body: {
      set: [
        {
          key: 'MODE',
          kind: 'literal',
          value: 'staging',
        },
      ],
      apply: false,
    },
  })

  const box = await createSandbox(h, production, {
    name: 'scratch',
    image: {
      ref: 'nginx:1.27',
    },
    network: 'environment',
    egress: {
      mode: 'allowlist',
      domains: [
        {
          domain: 'github.com',
          ports: [443, 22],
        },
      ],
    },
  })

  await waitForSandbox(h, box.id, 'running')
  const snapshot = await h.call('POST', `/v1/sandboxes/${box.id}/snapshots`, {
    token,
    body: {
      name: 'seed',
    },
  })

  await createSandbox(h, production, {
    name: 'parked',
    image: {
      ref: 'nginx:1.27',
    },
    start: false,
  })

  const scoped = await mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: locked,
        level: 'deploy',
      },
    ],
    'agent',
  )
  const stagedReply = await h.call('PATCH', `/v1/services/${lockedService.id}`, {
    token: scoped,
    body: {
      limits: {
        memory_bytes: 268435456,
      },
      deploy: false,
    },
  })

  h.fakeStations[0]?.report()

  return {
    station,
    project,
    production,
    staging,
    locked,
    sandbox: box.id,
    snapshot: snapshot.body.id,
    services: {
      db: db.id,
      web: web.id,
      worker: worker.id,
      cron: cron.id,
      stagingWeb: stagingWeb.id,
    },
    lockedService: lockedService.id,
    scoped,
    staged: stagedReply.status === 202 ? stagedReply.body : null,
  }
}
