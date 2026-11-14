import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { setupInstance } from '../src/auth/bootstrap.ts'
import { component } from '../src/db/schema.ts'

import { adminEmail, adminPassword, startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { enrollFakeStation } from './helpers/fake-station.ts'

const bootstrapToken = `sly-enroll-${randomBytes(12).toString('base64url')}`

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

const manifest = JSON.stringify({
  schema: 1,
  release: '0.1.0',
  channel: 'stable',
  published_at: '2026-11-08T00:00:00Z',
  changelog: '',
  components: {
    stationd: {
      kind: 'binary',
      version: '0.1.0',
      source: 'registry.test/stationly/release',
      digest: null,
      platforms: {
        'linux/amd64': sha('stationd'),
        'linux/arm64': sha('stationd-arm'),
      },
    },
    dispatch: {
      kind: 'image',
      version: '0.1.0',
      source: 'registry.test/stationly/dispatch',
      digest: sha('index'),
      platforms: {
        'linux/amd64': sha('amd64'),
        'linux/arm64': sha('arm64'),
      },
    },
  },
})

describe('install records the platform components', () => {
  let h: Dispatch
  let hostId: string

  before(async () => {
    process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256 = createHash('sha256')
      .update(bootstrapToken)
      .digest('hex')
    h = await startDispatch({
      setup: false,
    })
    hostId = (await enrollFakeStation(await h.stationUrl(), bootstrapToken)).station_id
  })

  after(async () => {
    delete process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256
    await h.close()
  })

  test('only dispatch is an instance row; every other component belongs to the hosting station', async () => {
    await setupInstance(
      {
        db: h.deps.db,
        keyring: h.deps.keyring,
        auth: h.deps.auth,
      },
      {
        email: adminEmail,
        password: adminPassword,
        release: {
          manifest,
          bundle: '{}',
          source: 'registry.test/stationly/release:v0.1.0',
        },
      },
      {
        type: 'station',
        id: hostId,
        client: 'test',
      },
    )

    const rows = h.db.select().from(component).all()
    const instance = rows.filter((row) => row.station_id === null).map((row) => row.name)

    assert.ok(instance.every((name) => name === 'dispatch'))
    assert.deepEqual(
      rows.filter((row) => row.station_id === hostId).map((row) => row.name),
      ['stationd'],
    )
  })
})
