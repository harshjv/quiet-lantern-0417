import { Type, type Static } from '@sinclair/typebox'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import {
  baseImageCheckValues,
  componentNameValues,
  componentStatusValues,
  doctorStatusValues,
  ErrorBody,
  JsonObject,
  Lockfile,
  Nullable,
  platformUpgradeStatusValues,
  PlatformVerifyReleaseResult,
  PlatformVerifyResult,
  PlatformVerifyResultBody,
  releaseChannelValues,
  signatureStateValues,
  StringEnum,
  type LockfileDoc,
  type MessageBody,
} from '@stationly/protocol'

import { component, station } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { baseImageInventory, intervalS } from '../../platform/base-images.ts'
import { doctorFor, runDoctor } from '../../platform/doctor.ts'
import {
  currentRelease,
  effectivePins,
  lockfileFor,
  readLockfile,
  resolvePins,
  storeRelease,
} from '../../platform/lockfile.ts'
import { fetchRelease, ReleaseFetchError } from '../../platform/releases.ts'
import {
  activeUpgrade,
  latestUpgrade,
  overlayPins,
  planUpgrade,
  procedureNotes,
} from '../../platform/upgrade.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit } from '../context.ts'
import { fail } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { stationByRef } from '../lookup.ts'
import { replies, Staged } from '../shapes.ts'

import { stationError } from './runs.ts'

const Str = Type.String()
const NStr = Nullable(Type.String())

const ComponentItem = Type.Object(
  {
    id: Str,
    name: StringEnum(componentNameValues),
    station_id: NStr,
    version: Str,
    digest: NStr,
    since: Str,
    status: StringEnum(componentStatusValues),
    signature: StringEnum(signatureStateValues),
    failure: Nullable(ErrorBody),
    lockfile_version: Str,
    lockfile_digest: NStr,
    drift: Type.Boolean(),
  },
  {
    additionalProperties: false,
  },
)

const UpgradePin = Type.Object({
  version: Str,
  digest: NStr,
})

const UpgradeView = Type.Object(
  {
    id: Str,
    status: StringEnum(platformUpgradeStatusValues),
    release: Type.Object(
      {
        from: Str,
        to: Str,
      },
      {
        additionalProperties: false,
      },
    ),
    station: NStr,
    staged_change: NStr,
    started_at: Str,
    finished_at: NStr,
    backup: NStr,
    failure: Nullable(ErrorBody),
    steps: Type.Array(
      Type.Object(
        {
          component: Str,
          station: NStr,
          status: StringEnum([
            'pending',
            'running',
            'done',
            'failed',
            'reverting',
            'reverted',
            'revert_failed',
          ]),
          from: UpgradePin,
          to: UpgradePin,
          started_at: NStr,
          finished_at: NStr,
          failure: Nullable(ErrorBody),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

const Inventory = Type.Object(
  {
    release: Nullable(
      Type.Object(
        {
          version: Str,
          channel: StringEnum(releaseChannelValues),
          manifest_digest: Str,
          published_at: Str,
          changelog: Str,
          source: Str,
          verified_by: NStr,
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    lockfile: Nullable(Lockfile),
    upgrade: Nullable(UpgradeView),
    items: Type.Array(ComponentItem),
    sandbox_storage: Type.Array(
      Type.Object(
        {
          station: Str,
          backing: StringEnum(['device', 'loop_file']),
          size_bytes: Type.Integer(),
          free_bytes: Type.Integer(),
          max_size_bytes: Type.Integer(),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    base_images: Type.Array(
      Type.Object(
        {
          ref: Str,
          registry: Str,
          checks: Type.Array(
            Type.Object(
              {
                service_id: Str,
                service: Str,
                deployment_id: Str,
                digest: Str,
                check: StringEnum(baseImageCheckValues),
                checked_at: NStr,
                latest_digest: NStr,
              },
              {
                additionalProperties: false,
              },
            ),
          ),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    base_image_checks: Type.Object(
      {
        interval_s: Type.Integer(),
        enabled: Type.Boolean(),
      },
      {
        additionalProperties: false,
      },
    ),
    next_cursor: Type.Null(),
  },
  {
    additionalProperties: false,
  },
)

const DoctorStatus = StringEnum(doctorStatusValues)

const Doctor = Type.Object(
  {
    status: DoctorStatus,
    checked_at: Str,
    checks: Type.Array(
      Type.Object(
        {
          name: Str,
          station: NStr,
          status: DoctorStatus,
          code: NStr,
          finding: Str,
          fix: NStr,
          detail: Type.Optional(JsonObject),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

const Releases = Type.Object(
  {
    enabled: Type.Boolean(),
    current: NStr,
    available: Type.Array(Type.Unknown()),
  },
  {
    additionalProperties: false,
  },
)

const upgradeOutcome = {
  id: NStr,
  status: StringEnum(['plan', 'accepted']),
  upgrade: Type.Optional(NStr),
}

const ReleaseUpgrade = Type.Object(
  {
    ...upgradeOutcome,
    release: Type.Object(
      {
        from: Str,
        to: Str,
        manifest_digest: Str,
        changelog: Str,
        removed_overrides: Type.Array(Str),
      },
      {
        additionalProperties: false,
      },
    ),
    changes: Type.Array(
      Type.Object(
        {
          order: Type.Integer(),
          component: Str,
          station: NStr,
          from: UpgradePin,
          to: UpgradePin,
          procedure: Str,
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    verification: Type.Array(
      Type.Object(
        {
          station_id: Str,
          release: Nullable(PlatformVerifyReleaseResult),
          items: Type.Array(PlatformVerifyResult),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

const OverrideUpgrade = Type.Object(
  {
    ...upgradeOutcome,
    release: Str,
    changes: Type.Array(
      Type.Object(
        {
          component: Str,
          before: Type.Unknown(),
          after: Type.Unknown(),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    verification: Nullable(
      Type.Object(
        {
          station_id: Str,
          ...PlatformVerifyResultBody.properties,
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

const lockfileComponents = new Set([
  'dispatch',
  'gateway',
  'cloudflared',
  'buildkit',
  'depot',
  'litestream',
  'guard_image',
  'coupler_image',
  'railpack_frontend',
  'syft_scanner',
])

const componentView = (c: typeof component.$inferSelect) => ({
  id: c.id,
  name: c.name,
  station_id: c.station_id,
  version: c.version,
  digest: c.digest,
  since: c.since.toISOString(),
  status: c.status,
  signature: c.signature,
  failure: c.failure,
  lockfile_version: c.lockfile_version,
  lockfile_digest: c.lockfile_digest,
  drift:
    c.station_id !== null &&
    c.name !== 'docker_engine' &&
    (c.version !== c.lockfile_version ||
      (c.lockfile_digest !== null && c.digest !== c.lockfile_digest)),
})

const upgradeView = (row: ReturnType<typeof latestUpgrade>) =>
  row && {
    id: row.id,
    status: row.status,
    release: {
      from: row.release_from,
      to: row.release_to,
    },
    station: row.station_id,
    staged_change: row.staged_change_id,
    started_at: row.created_at.toISOString(),
    finished_at: row.finished_at?.toISOString() ?? null,
    backup: row.backup,
    failure: row.failure,
    steps: row.steps.map((s) => ({
      component: s.component,
      station: s.station_id,
      status: s.status,
      from: s.from,
      to: s.to,
      started_at: s.started_at,
      finished_at: s.finished_at,
      failure: s.failure,
    })),
  }

export const platformRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps

  const verifyOn = async (
    stationId: string | null,
    items: MessageBody<'platform.verify'>['items'],
    release?: MessageBody<'platform.verify'>['release'],
  ) => {
    const candidates = stationId
      ? [stationId]
      : db
          .select({
            id: station.id,
          })
          .from(station)
          .where(isNull(station.revoked_at))
          .orderBy(asc(station.id))
          .all()
          .map((s) => s.id)
    const target = candidates.find((id) => stations.isConnected(id))

    if (!target) {
      return fail(
        'STATION_OFFLINE',
        'No connected station can verify signatures.',
        'Bring a station online, then retry.',
      )
    }

    const reply = await stations
      .ask(
        target,
        'platform.verify',
        release
          ? {
              items,
              release,
            }
          : {
              items,
            },
        {
          timeoutMs: 240_000,
        },
      )
      .catch(stationError)

    return {
      station_id: target,
      ...reply.body,
    }
  }

  const releaseUpgrade = async (
    call: Awaited<ReturnType<Kit['call']>>,
    lockfile: LockfileDoc,
    version: string,
    stationRef: string | undefined,
    plan: boolean,
    set: { status?: number | string },
  ): Promise<Static<typeof ReleaseUpgrade> | Static<typeof Staged>> => {
    const fetched = await fetchRelease(version).catch((error: unknown) => {
      if (error instanceof ReleaseFetchError) {
        return fail(
          error.code,
          error.message,
          error.code === 'RELEASE_NOT_FOUND'
            ? 'Name a published Stationly release.'
            : 'Check Dispatch egress to the releases repository, then retry.',
          {
            version,
            url: error.url,
          },
        )
      }

      throw error
    })
    const stationId = stationRef ? stationByRef(db, stationRef).id : null
    const after = lockfileFor(fetched.manifest, fetched.manifestDigest)
    const targets = db
      .select({
        id: station.id,
        arch: station.arch,
      })
      .from(station)
      .where(isNull(station.revoked_at))
      .orderBy(asc(station.id))
      .all()
      .filter((s) => !stationId || s.id === stationId)
    const verification: {
      station_id: string
      release: NonNullable<MessageBody<'platform.verify.result'>['release']> | null
      items: MessageBody<'platform.verify.result'>['items']
    }[] = []

    for (const st of targets) {
      const from = overlayPins(db, st.id, effectivePins(db, st.arch))
      const to = resolvePins(fetched.manifest, after, st.arch)

      if (!to.stationd?.digest) {
        fail(
          'VALIDATION_FAILED',
          `release ${version} publishes no stationd for linux/${st.arch ?? 'unknown'}, the architecture of station ${st.id}`,
          'Upgrade to a release built for every station architecture, or upgrade the other stations with --station.',
          {
            version,
            station_id: st.id,
            arch: st.arch,
          },
        )
      }

      const items: MessageBody<'platform.verify'>['items'] = []

      for (const [name, pin] of Object.entries(to)) {
        if (
          !pin.digest ||
          (from[name]?.digest === pin.digest && from[name]?.version === pin.version)
        ) {
          continue
        }

        if (pin.kind === 'image' || name === 'stationd') {
          items.push({
            component: name as MessageBody<'platform.verify'>['items'][number]['component'],
            version: pin.version,
            digest: pin.digest,
          })
        }
      }

      const reply = await verifyOn(st.id, items, {
        manifest: fetched.manifestRaw,
        bundle: fetched.bundle,
      })

      verification.push({
        station_id: reply.station_id,
        release: reply.release ?? null,
        items: reply.items,
      })
    }

    const releaseCheck = verification[0]?.release ?? null

    if (!releaseCheck || releaseCheck.signature !== 'verified') {
      audit(
        db,
        call,
        'platform.upgrade_refused',
        {
          entity: 'lockfile',
          id: 'platform.lockfile',
        },
        {
          after: {
            release: version,
            reason: releaseCheck?.failure?.explanation ?? 'no station verified the manifest',
          },
        },
      )
      fail(
        'UNSIGNED_ARTIFACT',
        `release-manifest.json for ${version} has no valid signature from the release signing identity: ${releaseCheck?.failure?.explanation ?? 'no station verified it'}`,
        'Upgrade to a release signed by the release signing identity.',
        {
          version,
          manifest_digest: fetched.manifestDigest,
        },
      )
    }

    const refused = verification.flatMap((v) =>
      v.items
        .filter((i) => i.signature === 'refused')
        .map((i) => ({
          ...i,
          station_id: v.station_id,
        })),
    )

    if (refused.length && !readSetting(db, 'platform.allow_unsigned')) {
      audit(
        db,
        call,
        'platform.upgrade_refused',
        {
          entity: 'lockfile',
          id: 'platform.lockfile',
        },
        {
          after: {
            release: version,
            refused: refused.map((r) => ({
              component: r.component,
              digest: r.digest,
              reason: r.failure?.explanation ?? null,
            })),
          },
        },
      )
      fail(
        'UNSIGNED_ARTIFACT',
        refused
          .map((r) => r.failure?.explanation ?? `${r.component} ${r.digest} is unsigned`)
          .join(' '),
        'Every digest a release pins must carry the release signature; nothing was changed.',
        {
          release: version,
          items: refused,
          verification,
        },
      )
    }

    storeRelease(db, {
      manifestRaw: fetched.manifestRaw,
      bundle: fetched.bundle,
      source: fetched.source,
      verifiedBy: releaseCheck!.identity ?? null,
    })
    const upgrade = planUpgrade(db, lockfile, after, stationId)
    const changes = upgrade.steps.map((s, i) => ({
      order: i + 1,
      component: s.component,
      station: s.station_id,
      from: s.from,
      to: s.to,
      procedure: procedureNotes[s.component] ?? 'pin recorded',
    }))
    const releaseView = {
      from: lockfile.release,
      to: version,
      manifest_digest: fetched.manifestDigest,
      changelog: fetched.manifest.changelog,
      removed_overrides: upgrade.removedOverrides,
    }

    if (plan) {
      return {
        id: null,
        status: 'plan',
        release: releaseView,
        changes,
        verification,
      }
    }

    if (!changes.length && lockfile.manifest_digest === fetched.manifestDigest) {
      return {
        id: null,
        status: 'accepted',
        release: releaseView,
        changes,
        verification,
      }
    }

    const set_ = new ChangeSet()

    set_.update('lockfile', 'platform.lockfile', '/', lockfile, after)
    const protect = readSetting(db, 'platform.protected') && !call.principal.human
    const result = commit(
      kit.deps,
      call,
      {
        environment: null,
        protect,
        station: stationId,
      },
      set_,
    )

    if (!result.applied) {
      return kit.stagedBody(result, set)
    }

    audit(
      db,
      call,
      'platform.lockfile_update',
      {
        entity: 'lockfile',
        id: 'platform.lockfile',
      },
      {
        after: {
          release: {
            from: lockfile.release,
            to: version,
          },
          changes: changes.length,
          upgrade: result.upgrade,
        },
      },
    )
    stations.reconcile()
    kit.deps.upgrades?.kick()

    return {
      id: result.staged.id,
      status: 'accepted',
      upgrade: result.upgrade,
      release: releaseView,
      changes,
      verification,
    }
  }

  return kit
    .router('platform', '/v1')
    .get(
      '/inventory',
      ({ query }) => {
        const stationId = query.station ? stationByRef(db, query.station).id : undefined
        const rows = db
          .select()
          .from(component)
          .where(
            and(
              stationId ? eq(component.station_id, stationId) : undefined,
              query.status
                ? eq(component.status, query.status as (typeof component.$inferSelect)['status'])
                : undefined,
            ),
          )
          .orderBy(asc(component.station_id), asc(component.name))
          .all()
        const lockfile = readLockfile(db)
        const release = currentRelease(db)

        return {
          release: release
            ? {
                version: release.release,
                channel: release.channel,
                manifest_digest: release.manifest_digest,
                published_at: release.manifest.published_at,
                changelog: release.manifest.changelog,
                source: release.source,
                verified_by: release.verified_by,
              }
            : null,
          lockfile,
          upgrade: upgradeView(latestUpgrade(db)),
          items: rows.map(componentView),
          sandbox_storage: db
            .select()
            .from(station)
            .where(
              and(stationId ? eq(station.id, stationId) : undefined, isNull(station.revoked_at)),
            )
            .all()
            .flatMap((st) =>
              st.capabilities?.sandboxes
                ? [
                    {
                      station: st.id,
                      backing: st.capabilities.sandboxes.filesystem_backing,
                      size_bytes: st.capabilities.sandboxes.filesystem_bytes,
                      free_bytes: st.capabilities.sandboxes.filesystem_free_bytes,
                      max_size_bytes: st.capabilities.sandboxes.filesystem_max_bytes,
                    },
                  ]
                : [],
            ),
          base_images: baseImageInventory(db),
          base_image_checks: {
            interval_s: intervalS(db),
            enabled: intervalS(db) > 0,
          },
          next_cursor: null,
        }
      },
      {
        operation: {
          id: 'platform_inventory',
          summary:
            'Components with versions, digests, signatures and lockfile drift; the pinned release; base images with their last check',
          level: 'instance read',
          cli: {
            render: 'inventory',
          },
        },
        query: t.Object({
          station: t.Optional(t.String()),
          status: t.Optional(t.String()),
        }),
        response: replies({
          200: Inventory,
        }),
      },
    )
    .get(
      '/doctor',
      async ({ query }) => {
        const stationId = query.station ? stationByRef(db, query.station).id : undefined
        const report = await runDoctor(
          {
            db,
            stations,
          },
          {
            station: stationId,
          },
        )
        const names = query.checks
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean)

        return {
          ...report,
          checks: doctorFor(report.checks, names),
        }
      },
      {
        operation: {
          id: 'platform_doctor',
          summary:
            'Health report: each check ok, warn or fail with a finding, a code and a fix; a row that changes status emits doctor.finding',
          level: 'instance read',
          cli: {
            render: 'doctor',
          },
        },
        query: t.Object({
          station: t.Optional(t.String()),
          checks: t.Optional(t.String()),
        }),
        response: replies({
          200: Doctor,
        }),
      },
    )
    .get(
      '/platform/releases',
      () => {
        const release = currentRelease(db)

        return {
          enabled: readSetting(db, 'platform.release_check'),
          current: release?.release ?? null,
          available: [],
        }
      },
      {
        operation: {
          id: 'platform_check',
          summary:
            'Releases newer than the pinned one; enabled = false while platform.release_check is false',
          level: 'instance read',
        },
        response: replies({
          200: Releases,
        }),
      },
    )
    .post(
      '/platform/upgrade',
      async ({ request, body, set }) => {
        const call = await kit.call(request)
        const lockfile =
          readLockfile(db) ??
          fail(
            'VALIDATION_FAILED',
            'platform.lockfile is not set; install a release first.',
            'Run stationd install and sly setup.',
          )
        const running = activeUpgrade(db)

        if (running && running.status !== 'failed' && !(body.plan ?? true)) {
          fail(
            'UPGRADE_IN_PROGRESS',
            `Upgrade ${running.id} (${running.release_from} to ${running.release_to}) is ${running.status}.`,
            'Wait for platform.upgrade_done, then retry.',
            {
              upgrade: running.id,
              status: running.status,
            },
          )
        }

        if (body.version !== undefined) {
          return releaseUpgrade(call, lockfile, body.version, body.station, body.plan ?? true, set)
        }

        const overrides = (body.overrides ?? {}) as Record<
          string,
          { version: string; digest: string; reason?: string } | { reset: true }
        >

        if (!Object.keys(overrides).length) {
          fail('VALIDATION_FAILED', 'Name at least one override.', undefined, {
            issues: [
              {
                path: '/overrides',
                message: 'empty',
              },
            ],
          })
        }

        const stationId = body.station ? stationByRef(db, body.station).id : null
        const arch = stationId
          ? db
              .select({
                arch: station.arch,
              })
              .from(station)
              .where(eq(station.id, stationId))
              .get()?.arch
          : undefined
        const pins = effectivePins(db, arch)
        const set_ = new ChangeSet()
        const verifyItems: MessageBody<'platform.verify'>['items'] = []
        const entries: { component: string; before: unknown; after: unknown }[] = []

        for (const [name, o] of Object.entries(overrides)) {
          if (!lockfileComponents.has(name)) {
            fail(
              'VALIDATION_FAILED',
              `${name} cannot be overridden by digest here.`,
              'Override an image component.',
              {
                issues: [
                  {
                    path: `/overrides/${name}`,
                    message: 'not an image component',
                  },
                ],
              },
            )
          }

          const before = lockfile.overrides[name] ?? null

          if ('reset' in o) {
            if (!before) {
              continue
            }

            set_.update('lockfile', 'platform.lockfile', `/overrides/${name}`, before, null)
            entries.push({
              component: name,
              before: {
                ...pins[name],
              },
              after: null,
            })
            continue
          }

          if (!/^sha256:[0-9a-f]{64}$/.test(o.digest)) {
            fail(
              'VALIDATION_FAILED',
              `overrides.${name}.digest must be sha256:<64 hex>; a tag is never a pin.`,
              undefined,
              {
                issues: [
                  {
                    path: `/overrides/${name}/digest`,
                    message: `not a digest: ${JSON.stringify(o)}`,
                  },
                ],
              },
            )
          }

          const source =
            pins[name]?.source ??
            fail('VALIDATION_FAILED', `${name} is not in release ${lockfile.release}.`)
          const after = {
            version: o.version,
            digest: o.digest,
            source,
            reason: o.reason ?? '',
          }

          verifyItems.push({
            component: name as MessageBody<'platform.verify'>['items'][number]['component'],
            version: o.version,
            digest: o.digest,
          })
          set_.update('lockfile', 'platform.lockfile', `/overrides/${name}`, before, after)
          entries.push({
            component: name,
            before: pins[name] ?? null,
            after,
          })
        }

        const verification = verifyItems.length ? await verifyOn(stationId, verifyItems) : null
        const allowUnsigned = readSetting(db, 'platform.allow_unsigned')
        const refused = verification?.items.filter((i) => i.signature === 'refused') ?? []

        if (refused.length && !allowUnsigned) {
          audit(
            db,
            call,
            'platform.upgrade_refused',
            {
              entity: 'lockfile',
              id: 'platform.lockfile',
            },
            {
              after: {
                refused: refused.map((r) => ({
                  component: r.component,
                  digest: r.digest,
                  reason: r.failure?.explanation ?? null,
                })),
              },
            },
          )
          fail(
            'UNSIGNED_ARTIFACT',
            refused
              .map((r) => r.failure?.explanation ?? `${r.component} ${r.digest} is unsigned`)
              .join(' '),
            'Pin a digest the release signing identity signed.',
            {
              items: verification!.items,
              station_id: verification!.station_id,
            },
          )
        }

        if (body.plan ?? true) {
          return {
            id: null,
            status: 'plan',
            release: lockfile.release,
            changes: entries,
            verification,
          }
        }

        if (set_.empty) {
          return {
            id: null,
            status: 'accepted',
            release: lockfile.release,
            changes: [],
            verification,
          }
        }

        const protect = readSetting(db, 'platform.protected') && !call.principal.human
        const result = commit(
          kit.deps,
          call,
          {
            environment: null,
            protect,
            station: stationId,
          },
          set_,
        )

        if (!result.applied) {
          return kit.stagedBody(result, set)
        }

        audit(
          db,
          call,
          'platform.lockfile_update',
          {
            entity: 'lockfile',
            id: 'platform.lockfile',
          },
          {
            after: {
              changes: entries,
            },
          },
        )
        stations.reconcile()
        kit.deps.upgrades?.kick()

        return {
          id: result.staged.id,
          status: 'accepted',
          upgrade: result.upgrade,
          release: lockfile.release,
          changes: entries,
          verification,
        }
      },
      {
        operation: {
          id: 'platform_upgrade',
          summary:
            'Plan or apply lockfile overrides; every new digest is signature-checked by a station first (UNSIGNED_ARTIFACT)',
          level: 'instance admin',
          cli: false,
        },
        body: t.Object({
          version: t.Optional(t.String()),
          overrides: t.Optional(
            t.Record(
              t.String(),
              t.Union([
                t.Object({
                  version: t.String(),
                  digest: t.String(),
                  reason: t.Optional(t.String()),
                }),
                t.Object({
                  reset: t.Literal(true),
                }),
              ]),
            ),
          ),
          station: t.Optional(t.String()),
          plan: t.Optional(t.Boolean()),
        }),
        response: replies({
          200: Type.Union([ReleaseUpgrade, OverrideUpgrade]),
          202: Staged,
        }),
      },
    )
}
