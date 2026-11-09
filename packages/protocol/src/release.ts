import { Type, type Static } from '@sinclair/typebox'
import { ComponentName, ErrorBody } from './model.ts'
import { Count, Digest, IdMap, Nullable, StringEnum, Timestamp } from './primitives.ts'

export const releasePlatformValues = ['linux/amd64', 'linux/arm64'] as const

export const ReleasePlatform = StringEnum(releasePlatformValues, { title: 'ReleasePlatform' })

export const releaseComponentKindValues = ['image', 'binary', 'archive'] as const

export const ReleaseComponentKind = StringEnum(releaseComponentKindValues, { title: 'ReleaseComponentKind' })

export const ReleasePlatforms = Type.Object(
  { 'linux/amd64': Type.Optional(Digest), 'linux/arm64': Type.Optional(Digest) },
  { title: 'ReleasePlatforms', additionalProperties: false, minProperties: 1 }
)

export const ReleaseComponent = Type.Object(
  {
    kind: ReleaseComponentKind,
    version: Type.String({ minLength: 1 }),
    source: Type.String({ minLength: 1 }),
    digest: Nullable(Digest),
    platforms: Nullable(ReleasePlatforms),
    variant: Type.Optional(Type.String())
  },
  { title: 'ReleaseComponent', additionalProperties: false }
)

export const ReleaseClientPlatforms = Type.Object(
  { 'linux/amd64': Type.Optional(Digest), 'linux/arm64': Type.Optional(Digest), 'darwin/amd64': Type.Optional(Digest), 'darwin/arm64': Type.Optional(Digest) },
  { title: 'ReleaseClientPlatforms', additionalProperties: false, minProperties: 1 }
)

export const ReleaseClient = Type.Object(
  { kind: Type.Literal('binary'), version: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }), platforms: ReleaseClientPlatforms },
  { title: 'ReleaseClient', additionalProperties: false }
)

export const ReleaseClients = Type.Object({ sly: ReleaseClient }, { title: 'ReleaseClients', additionalProperties: false })

export const releaseChannelValues = ['stable', 'edge'] as const

export const ReleaseChannel = StringEnum(releaseChannelValues, { title: 'ReleaseChannel' })

export const ReleaseManifest = Type.Object(
  {
    schema: Type.Literal(1),
    release: Type.String({ minLength: 1 }),
    channel: ReleaseChannel,
    published_at: Timestamp,
    changelog: Type.String(),
    components: IdMap(ReleaseComponent),
    clients: Type.Optional(ReleaseClients)
  },
  { title: 'ReleaseManifest', additionalProperties: false }
)

export const LockfileOverride = Type.Object(
  { version: Type.String({ minLength: 1 }), digest: Digest, source: Type.String({ minLength: 1 }), reason: Type.String() },
  { title: 'LockfileOverride', additionalProperties: false }
)

export const Lockfile = Type.Object(
  {
    schema: Type.Literal(2),
    release: Type.String({ minLength: 1 }),
    channel: ReleaseChannel,
    manifest_digest: Digest,
    updated_at: Timestamp,
    overrides: IdMap(LockfileOverride),
    grype_db: Nullable(Type.Object({ digest: Digest, built: Timestamp }, { title: 'LockfileGrypeDb' })),
    templates: IdMap(Type.Object({ version: Type.String(), image_digest: Digest }, { title: 'LockfileTemplate' }))
  },
  { title: 'Lockfile', additionalProperties: false }
)

export const PlatformMirror = Type.Object(
  {
    lockfile: Lockfile,
    release_manifest: Nullable(ReleaseManifest),
    effective: IdMap(Type.Object({ version: Type.String(), digest: Nullable(Digest), source: Nullable(Type.String()) }, { title: 'EffectivePin' })),
    written_at: Timestamp
  },
  { title: 'PlatformMirror' }
)

export const signatureStateValues = ['verified', 'unsigned_allowed', 'refused', 'not_applicable', 'pending'] as const

export const SignatureState = StringEnum(signatureStateValues, { title: 'SignatureState' })

export const bundleSourceValues = ['cache', 'direct', 'dispatch'] as const

export const PlatformVerifyItem = Type.Object(
  { component: ComponentName, version: Type.String(), digest: Digest },
  { title: 'PlatformVerifyItem' }
)

export const PlatformVerifyRelease = Type.Object(
  { manifest: Type.String({ minLength: 1 }), bundle: Type.String({ minLength: 1 }) },
  { title: 'PlatformVerifyRelease' }
)

export const PlatformVerifyBody = Type.Object(
  { items: Type.Array(PlatformVerifyItem, { maxItems: 32 }), release: Type.Optional(PlatformVerifyRelease) },
  { title: 'PlatformVerifyBody' }
)

export const PlatformVerifyResult = Type.Object(
  {
    component: ComponentName,
    version: Type.String(),
    digest: Digest,
    signature: SignatureState,
    identity: Nullable(Type.String()),
    bundle_source: Nullable(StringEnum(bundleSourceValues, { title: 'BundleSource' })),
    bundles_seen: Count,
    duration_ms: Count,
    failure: Nullable(ErrorBody)
  },
  { title: 'PlatformVerifyResult' }
)

export const PlatformVerifyReleaseResult = Type.Object(
  { manifest_digest: Digest, signature: SignatureState, identity: Nullable(Type.String()), failure: Nullable(ErrorBody) },
  { title: 'PlatformVerifyReleaseResult' }
)

export const PlatformVerifyResultBody = Type.Object(
  { trusted_root: Nullable(Digest), items: Type.Array(PlatformVerifyResult), release: Type.Optional(PlatformVerifyReleaseResult) },
  { title: 'PlatformVerifyResultBody' }
)

export const releaseRoots = [ReleaseManifest, Lockfile, PlatformMirror] as const

export type ReleaseManifestDoc = Static<typeof ReleaseManifest>
export type ReleaseComponentDoc = Static<typeof ReleaseComponent>
export type LockfileDoc = Static<typeof Lockfile>
export type PlatformMirrorDoc = Static<typeof PlatformMirror>
export type PlatformVerifyResultDoc = Static<typeof PlatformVerifyResult>
