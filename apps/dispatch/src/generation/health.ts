import type { HealthDoc } from '@stationly/manifest-schema'

export type PortDoc = { port: number; protocol: 'http' | 'tcp' }

export const normalizeHealth = (kind: string, ports: PortDoc[], input: HealthDoc | undefined) => {
  if (kind === 'cron' || kind === 'one_off') {
    return null
  }

  const firstHttp = ports.find((p) => p.protocol === 'http')
  const type =
    input?.type ?? (kind === 'worker' || ports.length === 0 ? 'alive' : firstHttp ? 'http' : 'tcp')
  const interval = input?.interval_s ?? 5
  const timing = {
    interval_s: interval,
    timeout_s: input?.timeout_s ?? Math.min(3, interval),
    passes: input?.passes ?? 2,
    failures: input?.failures ?? 3,
  }

  if (type === 'http') {
    return {
      type,
      path: input?.path ?? '/',
      port: input?.port ?? firstHttp?.port ?? 0,
      ...(input?.host === undefined
        ? {}
        : {
            host: input.host,
          }),
      ...timing,
      startup_timeout_s: input?.startup_timeout_s ?? 120,
    }
  }

  if (type === 'tcp') {
    return {
      type,
      port: input?.port ?? ports[0]?.port ?? 0,
      ...timing,
      startup_timeout_s: input?.startup_timeout_s ?? 60,
    }
  }

  if (type === 'image') {
    return {
      type,
    }
  }

  return {
    type,
    seconds: input?.seconds ?? 10,
  }
}

export const healthPortMissing = (health: ReturnType<typeof normalizeHealth>, ports: PortDoc[]) =>
  health && 'port' in health && !ports.some((p) => p.port === health.port) ? health.port : null

export const undeclaredHealthPort = (
  health: ReturnType<typeof normalizeHealth>,
  ports: PortDoc[],
) => {
  const port = healthPortMissing(health, ports)

  return port === null ? null : `health.port ${port || '(none)'} is not in ports.`
}

export type StoredHealth = ReturnType<typeof normalizeHealth>

export const effectiveHealth = (kind: string, ports: PortDoc[], stored: StoredHealth | undefined) =>
  stored ?? normalizeHealth(kind, ports, undefined)
