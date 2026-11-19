import { localOrigin, mintToken, startFakeStation, type Dispatch } from './dispatch.ts'
import type { FakeStation } from './fake-station.ts'
import type { FakeRegistry } from './registry.ts'
import {
  approveWaiting,
  createApp,
  createMachine,
  createPreview,
  createProject,
  placed,
  productionId,
  rows,
  seedLockfile,
  waitForActive,
  waitForDeployment,
  waitForMachine,
} from './seed.ts'

export type World = {
  station: FakeStation
  project: { id: string; name: string }
  production: string
  staging: string
  locked: string
  apps: Record<string, string>
  machine: string
  snapshot: string
  lockedApp: string
  scoped: string
  waiting: { id: string } | null
}

export const seedWorld = async (h: Dispatch, registry: FakeRegistry): Promise<World> => {
  const token = h.admin.token

  registry.publish('postgres:17')
  registry.publish('nginx:1.27')
  seedLockfile(h)
  const station = await startFakeStation(h, 'station-1', {
    machines: {},
  })
  const project = await createProject(h, 'shop')
  const production = productionId(h, project.id)
  const staging = (await createPreview(h, 'shop', 'staging')).id as string
  const locked = production

  const db = await createApp(h, production, {
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
  const web = await createApp(h, production, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
    keys: [
      {
        name: 'DATABASE_URL',
        kind: 'reference',
        reference: 'postgres://app@${{db.HOST}}:5432/app',
      },
      {
        name: 'API_KEY',
        kind: 'sealed',
        value: 'hunter2',
      },
      {
        name: 'MODE',
        kind: 'literal',
        value: 'production',
      },
    ],
  })
  const worker = await createApp(h, production, {
    name: 'worker',
    kind: 'worker',
    ref: 'nginx:1.27',
    deploy: true,
  })
  const cron = await createApp(h, production, {
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
  const stagingWeb = await createApp(h, staging, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
  })
  const lockedCreate = await h.call('POST', placed(h, locked, 'apps'), {
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
  const approved = await h.call('POST', `/v1/approvals/${lockedCreate.body.id}/decision`, {
    body: {
      decision: 'approve',
    },
    cookie: h.admin.cookie,
    origin: localOrigin,
  })

  if (approved.status !== 200) {
    throw new Error(`could not approve the waiting app: ${approved.text}`)
  }

  const lockedApp = {
    id: rows<{ id: string }>(
      h,
      "select id from app where target_id = ? and name = 'api'",
      locked,
    )[0]!.id,
  }

  await waitForDeployment(h, stagingWeb.deployments[0].id, 'active')

  for (const created of [db, web, worker]) {
    await waitForActive(h, created.id)
  }

  await waitForActive(h, db.id)

  const webPort = web.ports[0].id as string

  await approveWaiting(
    h,
    await h.call('POST', `/v1/ports/${webPort}/domains`, {
      token,
      body: {
        generated: true,
      },
    }),
  )
  await h.call('PATCH', `/v1/apps/${stagingWeb.id}/keys`, {
    token,
    body: {
      set: [
        {
          name: 'MODE',
          kind: 'literal',
          value: 'staging',
        },
      ],
      apply: false,
    },
  })

  const box = await createMachine(h, staging, {
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

  await waitForMachine(h, box.id, 'running')
  const snapshot = await h.call('POST', `/v1/machines/${box.id}/snapshots`, {
    token,
    body: {
      name: 'seed',
    },
  })

  await createMachine(h, staging, {
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
        target: 'production',
        level: 'deploy',
      },
    ],
    'agent',
  )
  const waitingReply = await h.call('PATCH', `/v1/apps/${lockedApp.id}`, {
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
    machine: box.id,
    snapshot: snapshot.body.id,
    apps: {
      db: db.id,
      web: web.id,
      worker: worker.id,
      cron: cron.id,
      stagingWeb: stagingWeb.id,
    },
    lockedApp: lockedApp.id,
    scoped,
    waiting: waitingReply.status === 202 ? waitingReply.body : null,
  }
}
