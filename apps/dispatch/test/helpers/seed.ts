import { releaseRepositories } from '@stationly/protocol/release-config'
import { setting } from '../../src/db/schema.ts'
import { eq } from 'drizzle-orm'
import { lockfileFor, parseManifest, sha256Of, storeRelease } from '../../src/platform/lockfile.ts'
import type { Dispatch } from './dispatch.ts'

type Api = Pick<Dispatch, 'call' | 'admin'>

const must = <T>(reply: { status: number; body: T; text: string }, ...ok: number[]) => {
  if (!ok.includes(reply.status)) throw new Error(`seed call answered ${reply.status}: ${reply.text}`)
  return reply.body
}

export const createProject = async (h: Api, name = 'shop') => must<any>(await h.call('POST', '/v1/projects', { token: h.admin.token, body: { name } }), 201)

export const createEnvironment = async (h: Api, project: string, name: string, extra: Record<string, unknown> = {}, human = false) =>
  must<any>(
    await h.call('POST', `/v1/projects/${project}/environments`, human ? { cookie: h.admin.cookie, origin: 'http://127.0.0.1:7900', body: { name, deploy_on_create: false, ...extra } } : { token: h.admin.token, body: { name, deploy_on_create: false, ...extra } }),
    201
  )

export type ServiceSeed = { name: string; kind?: string; ref: string; ports?: { port: number; protocol?: string }[]; variables?: unknown[]; deploy?: boolean; extra?: Record<string, unknown> }

export const createService = async (h: Api, environmentId: string, seed: ServiceSeed) =>
  must<any>(
    await h.call('POST', `/v1/environments/${environmentId}/services`, {
      token: h.admin.token,
      body: { name: seed.name, kind: seed.kind ?? 'web', source: { type: 'image', ref: seed.ref }, ports: seed.ports, variables: seed.variables, deploy_on_create: seed.deploy ?? false, ...seed.extra }
    }),
    201,
    202
  )

export const listServices = async (h: Api, environmentId: string) => must<any>(await h.call('GET', `/v1/environments/${environmentId}/services?fields=*`, { token: h.admin.token }), 200).items as any[]

export const waitForActive = async (h: Api, serviceId: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const svc = must<any>(await h.call('GET', `/v1/services/${serviceId}?fields=current_deployment_id`, { token: h.admin.token }), 200)
    if (svc.current_deployment_id) return svc
    if (Date.now() > deadline) throw new Error(`service ${serviceId} never became current`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export const seedLockfile = (h: Pick<Dispatch, 'db'>) => {
  const value = { schema: 2, release: '0.0.0-test', channel: 'stable', manifest_digest: `sha256:${'0'.repeat(64)}`, updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), overrides: {}, grype_db: null, templates: {} }
  h.db.insert(setting).values({ key: 'platform.lockfile', value, updated_by: { type: 'system', id: null, client: 'test-harness' } }).onConflictDoUpdate({ target: setting.key, set: { value } }).run()
}

const digestOf = (c: string) => `sha256:${c.repeat(64)}`

const toolchainDigest = digestOf('e')

const releaseManifest = (release: string, gateway: boolean, sandboxes: boolean) =>
  JSON.stringify({
    schema: 1,
    release,
    channel: 'stable',
    published_at: '2026-11-01T00:00:00Z',
    changelog: '',
    components: {
      dispatch: { kind: 'binary', version: '0.0.0', source: releaseRepositories.dispatch, digest: digestOf('d'), platforms: null },
      ...(sandboxes ? { sandbox_toolchain: { kind: 'image', version: '0.1.0', source: releaseRepositories.sandbox_toolchain, digest: toolchainDigest, platforms: { 'linux/amd64': digestOf('f'), 'linux/arm64': digestOf('1') } } } : {}),
      ...(gateway ? { gateway: { kind: 'image', version: '3.7.18', source: 'docker.io/library/traefik', digest: digestOf('a'), platforms: { 'linux/amd64': digestOf('b'), 'linux/arm64': digestOf('c') } } } : {})
    }
  })

export const pinPlatform = (h: Pick<Dispatch, 'db'>, options: { gateway?: boolean; sandboxes?: boolean } = {}) => {
  const raw = releaseManifest(`0.0.0-test${options.gateway ? '-gateway' : ''}${options.sandboxes ? '-sandboxes' : ''}`, options.gateway ?? false, options.sandboxes ?? false)
  storeRelease(h.db, { manifestRaw: raw, bundle: '{}', source: 'test', verifiedBy: 'test' })
  const value = lockfileFor(parseManifest(raw), sha256Of(raw))
  const actor = { type: 'system', id: null, client: 'test-harness' }
  const existing = h.db.select().from(setting).where(eq(setting.key, 'platform.lockfile')).get()
  if (existing) h.db.update(setting).set({ value, updated_by: actor as never }).where(eq(setting.key, 'platform.lockfile')).run()
  else h.db.insert(setting).values({ key: 'platform.lockfile', value, updated_by: actor as never }).run()
}

export const waitForDeployment = async (h: Api & Partial<Pick<Dispatch, 'deps'>>, deploymentId: string, status: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    h.deps?.stations.reconcile()
    const dep = must<any>(await h.call('GET', `/v1/deployments/${deploymentId}`, { token: h.admin.token }), 200)
    if (dep.status === status) return dep
    if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stayed ${dep.status}, wanted ${status}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export const rows = <T = Record<string, unknown>>(h: Pick<Dispatch, 'db'>, sql: string, ...params: unknown[]) => ((h.db as unknown as { $client: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }).$client.prepare(sql).all(...params)) as T[]

export const toolchainImageDigest = toolchainDigest

export const createSandbox = async (h: Api, environmentId: string, body: Record<string, unknown> = {}, expect = [201]) =>
  must<any>(await h.call('POST', `/v1/environments/${environmentId}/sandboxes`, { token: h.admin.token, body }), ...expect)

export const waitForSandbox = async (h: Api & Partial<Pick<Dispatch, 'deps'>>, sandboxId: string, status: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    h.deps?.stations.reconcile()
    const box = must<any>(await h.call('GET', `/v1/sandboxes/${sandboxId}?fields=*`, { token: h.admin.token }), 200)
    if (box.status === status) return box
    if (Date.now() > deadline) throw new Error(`sandbox ${sandboxId} stayed ${box.status}, wanted ${status}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
