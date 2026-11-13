import { createApiClient } from '@stationly/api-client'

export const api = createApiClient(window.location.origin)

type V1 = typeof api.v1

type Data<F> = F extends (...args: never[]) => Promise<infer R>
  ? NonNullable<R extends { data: infer D } ? D : never>
  : never

type Failure<F> = F extends (...args: never[]) => Promise<infer R>
  ? NonNullable<R extends { error: infer E } ? E : never>
  : never

type Item<P> = P extends { items: (infer I)[] } ? I : never

export type ErrorBody = Failure<V1['me']['get']>['value']['error']

export type Me = Data<V1['me']['get']>
export type Project = Data<ReturnType<V1['projects']>['get']>
export type Environment = Data<ReturnType<V1['environments']>['get']>
export type NetworkMap = Data<ReturnType<V1['environments']>['network']['get']>
export type Connections = Data<ReturnType<V1['services']>['connections']['get']>
export type Explanation = Data<ReturnType<V1['environments']>['network']['explain']['get']>
export type Probe = Exclude<
  Data<ReturnType<V1['services']>['network']['probe']['post']>,
  {
    status: string
  }
>
export type DnsLog = Data<ReturnType<V1['services']>['dns-log']['get']>
export type Service = Data<ReturnType<V1['services']>['get']>
export type ServiceStatus = Service['status']
export type Deployment = Data<ReturnType<V1['deployments']>['get']>
export type DeploymentStatus = Deployment['status']
export type DeploymentStep = NonNullable<Deployment['steps']>[number]
export type Diagnosis = Data<ReturnType<V1['deployments']>['diagnosis']['get']>
export type Domain = Data<ReturnType<V1['domains']>['get']>
export type ServicePort = Item<Data<ReturnType<V1['services']>['ports']['get']>>
export type PortAllocation = Item<Data<ReturnType<V1['services']>['port-allocations']['get']>>
export type Variable = Data<ReturnType<V1['variables']>['get']>
export type Sandbox = Data<ReturnType<V1['sandboxes']>['get']>
export type SandboxStatus = Sandbox['status']
export type SandboxSnapshot = Item<Data<ReturnType<V1['environments']>['sandbox-snapshots']['get']>>
export type SandboxShell = Data<ReturnType<V1['sandboxes']>['shells']['post']>
export type StagedChange = Data<ReturnType<V1['staged-changes']>['get']>
export type Change = NonNullable<StagedChange['changes']>[number]
export type LogPage = Data<V1['logs']['get']>
export type LogLine = LogPage['untrusted']['lines'][number]
export type Event = Item<Data<V1['events']['get']>>
export type Token = Item<Data<V1['tokens']['get']>>
export type Station = Item<Data<V1['stations']['get']>>
export type Inventory = Data<V1['inventory']['get']>
export type InventoryComponent = Item<Inventory>
export type HostProbe = NonNullable<NonNullable<Station['capabilities']>['host']>

export class ApiFailure extends Error {
  readonly code: string
  readonly fix: string
  readonly details: Record<string, unknown>
  readonly status: number
  readonly requestId: string | null

  constructor(status: number, body: Partial<ErrorBody> | null) {
    super(body?.explanation ?? `Stationly answered with HTTP ${status}.`)
    this.code = body?.code ?? 'INTERNAL_ERROR'
    this.fix = body?.fix ?? 'Try again. If it fails again, share the request id below.'
    this.details = body?.details ?? {}
    this.status = status
    this.requestId = body?.request_id ?? null
  }
}

type EdenResult = { data: unknown; error: unknown; status: number }

type Body<R extends EdenResult> = NonNullable<R['data']>

type StagedShape = {
  status: 'staged' | 'accepted' | 'rejected' | 'superseded'
  refs: Record<string, string>
}

const failureOf = (result: EdenResult) => {
  const value = (result.error as { value?: unknown } | null)?.value
  const body =
    value && typeof value === 'object' && 'error' in value
      ? (value as { error: Partial<ErrorBody> }).error
      : null

  return new ApiFailure(result.status, body)
}

export const unwrap = async <R extends EdenResult>(call: Promise<R>): Promise<Body<R>> => {
  const result = await call

  if (result.error) {
    throw failureOf(result)
  }

  return result.data as Body<R>
}

export type Sent<R extends EdenResult> =
  | { body: Exclude<Body<R>, StagedShape>; staged: false }
  | { body: Extract<Body<R>, StagedShape>; staged: true }

export const send = async <R extends EdenResult>(call: Promise<R>): Promise<Sent<R>> => {
  const result = await call

  if (result.error) {
    throw failureOf(result)
  }

  if (result.status === 202) {
    return {
      body: result.data as Extract<Body<R>, StagedShape>,
      staged: true,
    }
  }

  return {
    body: result.data as Exclude<Body<R>, StagedShape>,
    staged: false,
  }
}

export type SentOf<F> = F extends (...args: never[]) => Promise<infer R extends EdenResult>
  ? Sent<R>
  : never

export const failureText = (error: unknown) =>
  error instanceof ApiFailure
    ? `${error.message} ${error.fix}`
    : error instanceof Error
      ? error.message
      : String(error)

export const idempotency = () => ({
  headers: {
    'idempotency-key': crypto.randomUUID(),
  },
})
