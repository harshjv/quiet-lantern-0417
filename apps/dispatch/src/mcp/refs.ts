import type { ServerContext } from '@modelcontextprotocol/server'
import type { Outcome } from '@stationly/mcp'
import { raw, type Session } from './api.ts'

export class Refusal extends Error {
  readonly envelope: unknown

  constructor(envelope: unknown) {
    super('refused')
    this.envelope = envelope
  }
}

export const invalid = (path: string, message: string): never => {
  throw new Refusal({
    error: {
      code: 'VALIDATION_FAILED',
      explanation: `${path}: ${message}`,
      fix: 'Correct the input named in details.issues and call the tool again.',
      details: { issues: [{ path, message }] }
    }
  })
}

export const must = <T = Record<string, unknown>>(result: Outcome): T => {
  if (!result.ok) throw new Refusal(result.envelope)
  return result.body as T
}

const segments = (ref: string, count: number, path: string, shape: string) => {
  const parts = ref.split('/')
  if (parts.length !== count || parts.some(p => p.length === 0)) invalid(path, `expected an id or ${shape}`)
  return parts.map(encodeURIComponent)
}

const idOf = (result: Outcome) => must<{ id: string }>(result).id

export const serviceId = async (session: Session, request: ServerContext, ref: string) => {
  if (ref.startsWith('svc_')) return ref
  const [project, environment, service] = segments(ref, 3, '/service', 'project/environment/service')
  return idOf(await raw(session, request, `/v1/projects/${project}/environments/${environment}/services/${service}`))
}

export const environmentId = async (session: Session, request: ServerContext, ref: string | undefined, project: string | undefined) => {
  if (ref?.startsWith('env_')) return ref
  if (ref?.includes('/')) {
    const [p, e] = segments(ref, 2, '/environment', 'project/environment')
    return idOf(await raw(session, request, `/v1/projects/${p}/environments/${e}`))
  }
  if (!project) return invalid('/project', 'required when environment is a name or omitted')
  if (!ref) return must<{ default_environment_id: string }>(await raw(session, request, `/v1/projects/${encodeURIComponent(project)}`)).default_environment_id
  return idOf(await raw(session, request, `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(ref)}`))
}

export const portId = async (session: Session, request: ServerContext, service: string, port: number) => {
  const ports = must<{ items: { id: string; port: number }[] }>(await raw(session, request, `/v1/services/${service}/ports`))
  return ports.items.find(p => p.port === port)?.id ?? invalid('/port', `service ${service} has no port ${port}`)
}
