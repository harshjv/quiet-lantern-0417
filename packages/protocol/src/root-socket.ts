import { Type, type Static, type TSchema } from '@sinclair/typebox'

import { messages } from './messages.ts'
import { ErrorBody } from './model.ts'
import { JsonObject, Nullable } from './primitives.ts'

export const rootSocketVersion = 1

export const rootSocketPath = '/run/stationly/stationd.sock'

export const stationdUnit = 'stationly-stationd'

const RawJson = Type.Unknown({
  goJSONSchema: {
    type: 'json.RawMessage',
    nillable: true,
    imports: ['encoding/json'],
  },
})

export const RootSocketRequest = Type.Object(
  {
    v: Type.Integer(),
    id: Type.String(),
    op: Type.String(),
    params: Type.Optional(RawJson),
  },
  {
    title: 'RootSocketRequest',
  },
)

export const RootSocketProgress = Type.Object(
  {
    step: Type.String(),
    detail: Type.Optional(
      Type.String({
        goJSONSchema: {
          type: 'string',
          nillable: true,
        },
      }),
    ),
  },
  {
    title: 'RootSocketProgress',
  },
)

export const RootSocketLine = Type.Object(
  {
    v: Type.Integer(),
    id: Type.String(),
    progress: Type.Optional(RootSocketProgress),
    ok: Type.Optional(Type.Boolean()),
    result: Type.Optional(RawJson),
    error: Type.Optional(ErrorBody),
  },
  {
    title: 'RootSocketLine',
  },
)

const NoParams = Type.Object(
  {},
  {
    title: 'RootSocketNoParams',
  },
)

const SetupParams = Type.Object(
  {
    email: Type.String(),
    password: Type.String(),
    acme_email: Type.Optional(Type.String()),
    hostnames: Type.Optional(
      Type.Object({
        api: Type.String(),
        dashboard: Type.String(),
      }),
    ),
    public_address: Type.Optional(Type.String()),
    litestream: Type.Optional(
      Type.Object({
        bucket: Type.String(),
        endpoint: Type.String(),
        access_key: Type.String(),
        secret_key: Type.String(),
      }),
    ),
  },
  {
    title: 'RootSocketSetupParams',
  },
)

const SetupResult = Type.Object(
  {
    admin_user_id: Type.String(),
    email: Type.String(),
    instance_id: Type.String(),
    settings: Type.Array(Type.String()),
    login_link: Nullable(Type.String()),
    login_link_expires_at: Type.String(),
    recovery_key: Type.Optional(Type.String()),
    lockfile: Nullable(
      Type.Object(
        {
          release: Nullable(Type.String()),
          manifest_digest: Nullable(Type.String()),
        },
        {
          title: 'RootSocketSetupLockfile',
        },
      ),
    ),
    hostnames: Nullable(
      Type.Object(
        {
          api: Type.String(),
          dashboard: Type.String(),
          status: Type.String(),
        },
        {
          title: 'RootSocketSetupHostnames',
        },
      ),
    ),
    public_address: Nullable(Type.String()),
    litestream: Nullable(
      Type.Object(
        {
          bucket: Type.String(),
          endpoint: Nullable(Type.String()),
          active: Type.Boolean(),
          note: Type.String(),
        },
        {
          title: 'RootSocketSetupLitestream',
        },
      ),
    ),
    reach: Type.Array(Type.String()),
  },
  {
    title: 'RootSocketSetupResult',
  },
)

const DetectedAddress = Type.Object(
  {
    address: Nullable(Type.String()),
    interface: Nullable(Type.String()),
    public: Type.Boolean(),
    reason: Type.Optional(Type.String()),
  },
  {
    title: 'RootSocketDetectedAddress',
  },
)

const RecoveryKey = Type.Object(
  {
    recovery_key: Type.String(),
  },
  {
    title: 'RootSocketRecoveryKey',
  },
)

const TokenParams = Type.Object(
  {
    scopes: Type.Optional(Type.Array(Type.String())),
    ttl_s: Type.Optional(Type.Integer()),
  },
  {
    title: 'RootSocketTokenParams',
  },
)

const RetainParams = Type.Object(
  {
    project_id: Type.String(),
  },
  {
    title: 'RootSocketRetainParams',
  },
)

const LogsParams = Type.Object(
  {
    deployment_id: Type.String(),
    tail: Type.Optional(Type.Integer()),
  },
  {
    title: 'RootSocketLogsParams',
  },
)

const op = <Params extends TSchema, Result extends TSchema>(params: Params, result: Result) => ({
  params,
  result,
})

export const rootSocketOps = {
  status: op(NoParams, JsonObject),
  'registry.token': op(TokenParams, JsonObject),
  'registry.delete': op(messages['registry.delete'].body, messages['registry.delete.result'].body),
  'registry.retain': op(RetainParams, JsonObject),
  'registry.gc': op(messages['registry.gc'].body, JsonObject),
  'secrets.status': op(NoParams, JsonObject),
  logs: op(LogsParams, JsonObject),
  setup: op(SetupParams, SetupResult),
  'public_address.detect': op(NoParams, DetectedAddress),
  'admin.recovery_key': op(NoParams, RecoveryKey),
  doctor: op(NoParams, messages['doctor.report'].body),
}

export type RootSocketOp = keyof typeof rootSocketOps
export type RootSocketParams<Op extends RootSocketOp> = Static<(typeof rootSocketOps)[Op]['params']>
export type RootSocketResult<Op extends RootSocketOp> = Static<(typeof rootSocketOps)[Op]['result']>
export type RootSocketRequestDoc = Static<typeof RootSocketRequest>
export type RootSocketLineDoc = Static<typeof RootSocketLine>

export const rootSocketRoots: TSchema[] = [
  RootSocketRequest,
  RootSocketLine,
  ...Object.values(rootSocketOps).flatMap((definition) => [definition.params, definition.result]),
].filter((schema) => schema.title !== undefined)
