import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { MessageBody } from '@stationly/protocol'
import { eq } from 'drizzle-orm'
import { audit_event, event, setting, station, volume, volume_snapshot } from '../src/db/schema.ts'
import { newId } from '../src/db/ids.ts'
import { setVariable } from '../src/secrets/variables.ts'
import { BackupError, backupPlan, pruneBackups, restoreBackup, startBackup, type BackupDeps } from '../src/volumes/backups.ts'
import { endpointIssue, s3TargetIssues } from '../src/volumes/s3-target.ts'
import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { createProject, createService, seedLockfile } from './helpers/seed.ts'

const accessKey = 'AKIAEXAMPLEKEY12345'
const secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const actor = { type: 'system' as const, id: null, client: 'test' }
const target = { type: 's3' as const, endpoint: 'http://10.0.0.5:9000', bucket: 'my-backups', prefix: 'prod/volumes', credentials_variable: 'BACKUP_S3' }

type Sent = { station: string; type: string; body: any }

describe('S3 volume backup targets', () => {
  let h: Dispatch
  let volumeId: string
  let stationId: string
  let otherStationId: string
  let projectId: string
  const sent: Sent[] = []
  const connected = new Set<string>()
  let failDelete = new Set<string>()

  const deps = (): BackupDeps => ({
    db: h.db,
    keyring: h.deps.keyring,
    stations: {
      isConnected: (id: string) => connected.has(id),
      reconcile: () => {},
      ask: async (stationId: string, type: string, body: unknown) => {
        sent.push({ station: stationId, type, body })
        if (type === 'volume.backup.delete') {
          const items = (body as MessageBody<'volume.backup.delete'>).items
          return { body: { items: items.map(i => ({ snapshot_id: i.snapshot_id, status: failDelete.has(i.snapshot_id) ? 'failed' : 'deleted', error: failDelete.has(i.snapshot_id) ? { code: 'INTERNAL_ERROR', explanation: 'bucket refused', fix: 'retry' } : null })) } }
        }
        return { body: {} }
      }
    } as unknown as BackupDeps['stations']
  })

  const setSetting = (key: string, value: unknown) => h.db.insert(setting).values({ key, value, updated_by: actor }).onConflictDoUpdate({ target: setting.key, set: { value } }).run()

  const setCredentials = (value: string, sealed = true) =>
    setVariable(h.db, h.deps.keyring, { scope: 'global', key: 'BACKUP_S3', value, sealed, actor, request_id: `req_${newId('message')}` })

  before(async () => {
    h = await startDispatch()
    seedLockfile(h)
    const first = await startFakeStation(h, 'one')
    const second = await startFakeStation(h, 'two')
    stationId = first.stationId
    otherStationId = second.stationId
    connected.add(stationId).add(otherStationId)
    const project = await createProject(h, 'shop')
    projectId = project.id
    const db = await createService(h, project.default_environment_id, { name: 'db', kind: 'worker', ref: 'postgres:17', extra: { volumes: [{ mount_path: '/data' }], strategy: 'replace', station_id: stationId } })
    volumeId = (h.db.select().from(volume).all().find(v => v.service_id === db.id) ?? h.db.select().from(volume).get()!).id
    setSetting('volume_backup.target', target)
    setCredentials(`${accessKey}:${secretKey}`)
  })

  after(async () => {
    await h.close()
  })

  test('the endpoint rule is https, or http on a private or loopback address', () => {
    for (const ok of ['https://s3.eu-west-1.amazonaws.com', 'http://10.0.0.5:9000', 'http://172.16.4.2', 'http://172.31.255.1', 'http://192.168.1.2:9000', 'http://127.0.0.1:9000', 'http://[::1]:9000', 'http://[fd12:3456::1]:9000']) {
      assert.equal(endpointIssue(ok), null, ok)
    }
    for (const bad of ['http://8.8.8.8:9000', 'http://172.32.0.1', 'http://minio.lan:9000', 'http://169.254.169.254', 'https://user:pass@host', 'ftp://10.0.0.5', 'https://host/path', 'https://host?x=1', 'host:9000', '']) {
      assert.notEqual(endpointIssue(bad), null, bad)
    }
  })

  test('bucket, prefix and variable names are checked', () => {
    assert.deepEqual(s3TargetIssues(target), [])
    assert.deepEqual(s3TargetIssues({ ...target, prefix: '' }), [])
    for (const bad of [{ bucket: 'Upper' }, { bucket: 'a' }, { prefix: '/lead' }, { prefix: 'trail/' }, { prefix: 'a/../b' }, { prefix: 'a b' }, { credentials_variable: 'lower' }]) {
      assert.notEqual(s3TargetIssues({ ...target, ...bad }).length, 0, JSON.stringify(bad))
    }
  })

  test('PATCH /v1/settings refuses an S3 target on a public http address and accepts a private one', async () => {
    const patch = (value: unknown) => h.call('PATCH', '/v1/settings', { cookie: h.admin.cookie, origin: 'http://127.0.0.1:7900', body: { 'volume_backup.target': value } })
    const refused = await patch({ ...target, endpoint: 'http://8.8.8.8:9000' })
    assert.equal(refused.status, 400, refused.text)
    assert.match(refused.text, /private or loopback/)
    const accepted = await patch(target)
    assert.ok(accepted.status === 200 || accepted.status === 202, accepted.text)
  })

  test('a plan refuses a missing, a non-sealed and a malformed credentials variable', async () => {
    const missing = { ...target, credentials_variable: 'NOT_THERE' }
    assert.throws(() => backupPlan(h.db, volumeId, missing), (e: unknown) => e instanceof BackupError && e.code === 'VALIDATION_FAILED' && /not a global variable/.test(e.message))
    setVariable(h.db, h.deps.keyring, { scope: 'global', key: 'PLAIN_S3', value: 'a:b', sealed: false, actor, request_id: 'req_plain' })
    assert.throws(() => backupPlan(h.db, volumeId, { ...target, credentials_variable: 'PLAIN_S3' }), (e: unknown) => e instanceof BackupError && /not sealed/.test(e.message))
    assert.equal(backupPlan(h.db, volumeId, undefined).target.type, 's3')
  })

  test('a backup delivers the credentials by secrets.deliver before volume.backup, and nothing else carries them', async () => {
    sent.length = 0
    const started = await startBackup(deps(), volumeId, { quiesce: false, trigger: 'manual', actor })
    assert.deepEqual(sent.map(s => s.type), ['secrets.deliver', 'volume.backup'])
    const deliver = sent[0]!.body as MessageBody<'secrets.deliver'>
    assert.equal(deliver.purpose, 'backup')
    assert.deepEqual(deliver.target, { snapshot_id: started.snapshot.id })
    const decoded = Object.fromEntries(deliver.values.map(v => [v.key, Buffer.from(v.value, 'base64url').toString('utf8')]))
    assert.deepEqual(decoded, { STATIONLY_S3_ACCESS_KEY_ID: accessKey, STATIONLY_S3_SECRET_ACCESS_KEY: secretKey })
    const job = sent[1]!.body as MessageBody<'volume.backup'>
    assert.deepEqual(job.target, { type: 's3', path: null, endpoint: target.endpoint, bucket: target.bucket, prefix: target.prefix })
    assert.equal(job.snapshot_id, started.snapshot.id)
    assert.equal(started.snapshot.location, `s3://my-backups/prod/volumes/${started.snapshot.objects!.archive}`)
    assert.deepEqual(started.snapshot.target, target)
    const everything = JSON.stringify([h.db.select().from(volume_snapshot).all(), h.db.select().from(audit_event).all(), h.db.select().from(event).all(), started])
    assert.ok(!everything.includes(secretKey), 'the secret key reached a stored row or a response')
    assert.ok(!everything.includes(accessKey), 'the access key id reached a stored row or a response')
    const decrypt = h.db.select().from(audit_event).all().filter(a => a.action === 'secret.decrypt' && a.purpose === 'backup')
    assert.equal(decrypt.length, 1)
    assert.equal((decrypt[0]!.target as { id: string }).id, started.snapshot.id)
  })

  test('a credentials value without ACCESS_KEY_ID:SECRET_ACCESS_KEY refuses the backup and leaves no row behind', async () => {
    setCredentials('no-colon-here')
    sent.length = 0
    const before = h.db.select().from(volume_snapshot).all().length
    await assert.rejects(startBackup(deps(), volumeId, { quiesce: false, trigger: 'manual', actor }), (e: unknown) => e instanceof BackupError && e.code === 'VALIDATION_FAILED' && /ACCESS_KEY_ID:SECRET_ACCESS_KEY/.test(e.message))
    assert.equal(sent.length, 0)
    assert.equal(h.db.select().from(volume_snapshot).all().length, before)
    setCredentials(`${accessKey}:${secretKey}`)
  })

  test('a station that refuses the job marks nothing complete and the error never shows the credentials', async () => {
    const failing = deps()
    ;(failing.stations as unknown as { ask: unknown }).ask = async (_s: string, type: string) => {
      if (type === 'volume.backup') throw Object.assign(new Error('station refused'), { code: 'VALIDATION_FAILED' })
      return { body: {} }
    }
    await assert.rejects(startBackup(failing, volumeId, { quiesce: false, trigger: 'manual', actor }), (e: unknown) => e instanceof BackupError && !e.message.includes(secretKey))
  })

  const completeSnapshots = (count: number, stationFor: string) => {
    const ids: string[] = []
    h.db.update(volume_snapshot).set({ status: 'failed' }).where(eq(volume_snapshot.volume_id, volumeId)).run()
    for (let i = 0; i < count; i++) {
      const id = newId('volume_snapshot')
      ids.push(id)
      const name = `${volumeId}-2026110${i + 1}T000000Z`
      h.db.insert(volume_snapshot).values({ id, volume_id: volumeId, station_id: stationFor, taken_at: new Date(Date.UTC(2026, 10, i + 1)), location: `s3://my-backups/prod/volumes/${name}.tar.zst`, source: 'tar', status: 'complete', trigger: 'manual', target, objects: { archive: `${name}.tar.zst`, metadata: `${name}.json` }, sha256: 'a'.repeat(64), consistent: true, finished_at: new Date() }).run()
    }
    return ids
  }

  test('retention keeps the newest volume_backup.keep and asks the volume\'s station to delete the older objects with credentials for each', async () => {
    const ids = completeSnapshots(4, otherStationId)
    setSetting('volume_backup.keep', 2)
    sent.length = 0
    const result = await pruneBackups(deps(), volumeId)
    assert.deepEqual(result.expired.sort(), [ids[0]!, ids[1]!].sort())
    assert.equal(result.kept, 2)
    const types = sent.map(s => s.type)
    assert.deepEqual(types, ['secrets.deliver', 'secrets.deliver', 'volume.backup.delete'])
    assert.ok(sent.every(s => s.station === stationId), 'an S3 object is deleted through the volume\'s own station, not the station that wrote it')
    const del = sent[2]!.body as MessageBody<'volume.backup.delete'>
    assert.deepEqual(del.items.map(i => i.snapshot_id).sort(), [ids[0]!, ids[1]!].sort())
    assert.ok(del.items.every(i => i.target.type === 's3' && i.target.bucket === 'my-backups' && !JSON.stringify(i).includes('credentials_variable')))
    const delivered = sent.slice(0, 2).map(s => (s.body as MessageBody<'secrets.deliver'>).target)
    assert.deepEqual(delivered.map(t => (t as { snapshot_id: string }).snapshot_id).sort(), [ids[0]!, ids[1]!].sort())
    assert.deepEqual(h.db.select().from(volume_snapshot).all().filter(s => s.status === 'expired').map(s => s.id).sort(), [ids[0]!, ids[1]!].sort())
  })

  test('an object the bucket refuses to delete stays complete and is retried at the next backup', async () => {
    const ids = completeSnapshots(3, stationId)
    setSetting('volume_backup.keep', 1)
    failDelete = new Set([ids[0]!])
    const result = await pruneBackups(deps(), volumeId)
    assert.deepEqual(result.expired, [ids[1]!])
    assert.equal(h.db.select().from(volume_snapshot).where(eq(volume_snapshot.id, ids[0]!)).get()!.status, 'complete')
    failDelete = new Set()
    const again = await pruneBackups(deps(), volumeId)
    assert.deepEqual(again.expired, [ids[0]!])
  })

  test('retention with a missing credentials variable expires nothing and sends no delete', async () => {
    const ids = completeSnapshots(3, stationId)
    setSetting('volume_backup.keep', 1)
    const original = h.db.select().from(volume_snapshot).where(eq(volume_snapshot.id, ids[0]!)).get()!
    h.db.update(volume_snapshot).set({ target: { ...target, credentials_variable: 'GONE' } }).where(eq(volume_snapshot.id, original.id)).run()
    h.db.update(volume_snapshot).set({ target: { ...target, credentials_variable: 'GONE' } }).where(eq(volume_snapshot.id, ids[1]!)).run()
    sent.length = 0
    const result = await pruneBackups(deps(), volumeId)
    assert.deepEqual(result.expired, [])
    assert.deepEqual(sent, [])
  })

  test('a restore from an S3 backup can name another station and delivers the credentials for that job', async () => {
    const ids = completeSnapshots(1, stationId)
    sent.length = 0
    const restored = await restoreBackup(deps(), volumeId, ids[0]!, actor, otherStationId)
    assert.equal(restored.station_id, otherStationId)
    assert.deepEqual(sent.map(s => [s.station, s.type]), [[otherStationId, 'secrets.deliver'], [otherStationId, 'volume.restore']])
    const job = sent[1]!.body as MessageBody<'volume.restore'>
    assert.equal(job.target.type, 's3')
    assert.equal(job.sha256, 'a'.repeat(64))
    const row = h.db.select().from(volume).where(eq(volume.id, restored.volume_id)).get()!
    assert.equal(row.station_id, otherStationId)
    assert.equal(row.status, 'retained')
    assert.equal(row.project_id, projectId)
  })

  test('a restore of a directory backup on another station is refused', async () => {
    const id = newId('volume_snapshot')
    h.db.insert(volume_snapshot).values({ id, volume_id: volumeId, station_id: stationId, taken_at: new Date(), location: 'x/y.tar.zst', source: 'tar', status: 'complete', trigger: 'manual', target: { type: 'path', path: 'x' }, objects: { archive: 'y.tar.zst', metadata: 'y.json' }, sha256: 'b'.repeat(64), finished_at: new Date() }).run()
    await assert.rejects(restoreBackup(deps(), volumeId, id, actor, otherStationId), (e: unknown) => e instanceof BackupError && e.code === 'VALIDATION_FAILED' && /cannot be restored/.test(e.message))
  })

  test('a restore on a revoked or unknown station is refused', async () => {
    const ids = completeSnapshots(1, stationId)
    await assert.rejects(restoreBackup(deps(), volumeId, ids[0]!, actor, 'stn_00000000000000000000000000'), (e: unknown) => e instanceof BackupError && e.code === 'NOT_FOUND')
    h.db.update(station).set({ revoked_at: new Date() }).where(eq(station.id, otherStationId)).run()
    await assert.rejects(restoreBackup(deps(), volumeId, ids[0]!, actor, otherStationId), (e: unknown) => e instanceof BackupError && e.code === 'NOT_FOUND')
  })
})
