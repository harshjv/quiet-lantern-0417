import { createServer, type RequestListener } from 'node:http'
import { dirname, join } from 'node:path'

import { toNodeHandler } from 'srvx/node'

import { networkLayout } from '@stationly/protocol'

import { createAttachServer } from './api/attach.ts'
import { createApp, createFetch } from './app.ts'
import { AuthService } from './auth/auth.ts'
import { ensureInstanceId, SetupError, setupInstance, type SetupInput } from './auth/bootstrap.ts'
import { createMetadataFetch } from './auth/metadata-fetch.ts'
import { createDashboard, dashboardDir } from './dashboard.ts'
import { openDb } from './db/client.ts'
import { env } from './env.ts'
import { createGitHub } from './github/service.ts'
import { log, logError } from './log.ts'
import { routeFetchThroughStation } from './net/resolver.ts'
import { startNotifier } from './notify/webhooks.ts'
import { startBaseImageChecker } from './platform/base-images.ts'
import { recordDispatchComponent } from './platform/lockfile.ts'
import { createUpgradeDriver } from './platform/upgrade.ts'
import { startSandboxRetention } from './sandboxes/lifecycle.ts'
import { startWorkspaceTokenRenewal } from './sandboxes/workspace.ts'
import { Keyring, masterKeyFromEnv } from './secrets/keyring.ts'
import { createStationServer, HostAdminError, type HostAdmin } from './station/server.ts'
import { pruneBackups, startBackupScheduler } from './volumes/backups.ts'

const {
  STATIONLY_PORT: port,
  STATIONLY_DISPATCH_VERSION: version,
  STATIONLY_DATABASE: databasePath,
  STATIONLY_RESOLVER: resolver,
  STATIONLY_LITESTREAM: replicated,
  STATIONLY_DISPATCH_DIGEST: digest,
} = env()

if (!databasePath) {
  throw new Error('STATIONLY_DATABASE must name the SQLite file Dispatch owns')
}

const routed = routeFetchThroughStation(resolver)

log('resolver', {
  address: resolver,
  fetch: routed ? 'through the stationd host listener' : 'host resolver (STATIONLY_RESOLVER unset)',
  cimd: resolver ? 'through the stationd host listener' : 'refused',
})
const db = openDb(databasePath, {
  replicated,
})

ensureInstanceId(db)
const masterKey = masterKeyFromEnv()
const keyring = new Keyring(db, masterKey)
const auth = new AuthService(
  db,
  masterKey,
  `http://${networkLayout.dispatchHostAddress}:${port}`,
  createMetadataFetch(resolver),
)
const blobDir = join(dirname(databasePath), 'blobs')
const github = createGitHub({
  db,
  keyring,
  auth,
})
const hostAdmin: HostAdmin = async (stationId, op, params) => {
  if (op !== 'setup') {
    throw new HostAdminError(
      'PROTOCOL_INVALID_MESSAGE',
      `host.admin op ${op} is not handled by this Dispatch`,
      'Send an op Dispatch documents.',
    )
  }

  try {
    const result = await setupInstance(
      {
        db,
        keyring,
        auth,
      },
      params as SetupInput,
      {
        type: 'station',
        id: stationId,
        client: 'sly root-socket',
      },
    )

    stations.reconcile(stationId)

    return result
  } catch (error) {
    if (error instanceof SetupError) {
      throw new HostAdminError(
        error.code,
        error.message,
        error.code === 'SETUP_DONE'
          ? 'Sign in as the existing admin; recovery is sly admin reset-password.'
          : 'Correct the input and run sly setup again.',
      )
    }

    throw error
  }
}
const onRecord = (stationId: string, type: string, body: unknown) => {
  const b = body as { status?: string; volume_id?: string }

  if (type === 'component.status') {
    upgrades.kick()
  }

  if (type === 'volume.backup.result' && b.status === 'complete' && b.volume_id) {
    pruneBackups(
      {
        db,
        stations,
        keyring,
      },
      b.volume_id,
    )
      .then(
        (r) =>
          r.expired.length &&
          log('volume_backup.pruned', {
            station_id: stationId,
            volume_id: b.volume_id,
            expired: r.expired,
            kept: r.kept,
          }),
      )
      .catch((error) =>
        log('volume_backup.prune_failed', {
          volume_id: b.volume_id,
          explanation: (error as Error).message,
        }),
      )
  }
}
const stations = createStationServer({
  db,
  keyring,
  blobDir,
  version,
  github,
  hostAdmin,
  onRecord,
})
const upgrades = createUpgradeDriver({
  db,
  databasePath,
  version,
  reconcile: (stationId) => stations.reconcile(stationId),
  log,
})
const deps = {
  db,
  keyring,
  auth,
  version,
  stations,
  blobDir,
  github,
  upgrades,
}
const app = createApp(deps)
const dashboard = createDashboard(dashboardDir, version)

log('dashboard', {
  built: dashboard.built,
  files: dashboard.files,
  dir: dashboardDir,
})
const appHandler = toNodeHandler(createFetch(deps, app, dashboard)) as RequestListener
const attach = createAttachServer(deps)
const notifier = startNotifier(deps)

github.start()
const baseImages = startBaseImageChecker(db)
const backupSchedule = startBackupScheduler(
  {
    db,
    stations,
    keyring,
  },
  log,
)
const sandboxRetention = startSandboxRetention(
  {
    db,
    stations,
  },
  log,
)
const workspaceTokens = startWorkspaceTokenRenewal(
  {
    db,
    auth,
  },
  log,
)

recordDispatchComponent(db, version)
log('dispatch.version', {
  version,
  digest: digest ?? null,
  database: databasePath,
})
const server = createServer((req, res) => {
  if (!stations.handleRequest(req, res)) {
    appHandler(req, res)
  }
})

server.on('upgrade', (req, socket, head) => {
  if (attach.matches(req)) {
    return attach.handleUpgrade(req, socket, head)
  }

  stations.handleUpgrade(req, socket, head)
})
server.listen(port, () =>
  log('listening', {
    port,
  }),
)

const shutdown = async () => {
  upgrades.stop()
  notifier.stop()
  baseImages.stop()
  backupSchedule.stop()
  sandboxRetention.stop()
  workspaceTokens.stop()
  github.stop()
  attach.close()
  await stations.close()
  server.close(() => process.exit(0))
  server.closeAllConnections()
}

const onSignal = () =>
  void shutdown().catch((error: unknown) => {
    logError('dispatch.shutdown_failed', {
      explanation: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  })

process.once('SIGTERM', onSignal)
process.once('SIGINT', onSignal)
