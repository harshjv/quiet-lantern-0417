import type { Service } from './api'

type Check = NonNullable<Service['health']>

const timing = (check: Extract<Check, { interval_s: number }>) =>
  `every ${check.interval_s} s, ${check.timeout_s} s timeout · ${check.passes} passes to go live, ${check.failures} failures to turn red`

export const healthLine = (health: Service['health']) => {
  if (!health) {
    return 'No health check; runs are judged by their exit code'
  }

  if (health.type === 'http') {
    const host = health.host ? ` with Host ${health.host}` : ''

    return `HTTP GET ${health.path} on port ${health.port}${host} · ${timing(health)}`
  }

  if (health.type === 'tcp') {
    return `TCP connect to port ${health.port} · ${timing(health)}`
  }

  if (health.type === 'image') {
    return 'The image’s own HEALTHCHECK'
  }

  return `Running for ${health.seconds} s without exiting`
}

export const healthWhy = (service: Pick<Service, 'kind' | 'health' | 'health_default'>) => {
  if (!service.health_default || !service.health) {
    return null
  }

  if (service.health.type === 'http') {
    return 'Default for a web service: the first http port'
  }

  if (service.health.type === 'tcp') {
    return 'Default for a web service with no http port: the first port'
  }

  return service.kind === 'worker'
    ? 'Default for a worker: it has no port to check'
    : 'Default for a service with no port'
}

export const healthPortNote = (
  health: Service['health'],
  ports: readonly { port: number }[] | undefined,
) => {
  if (!health || !('port' in health) || !ports || ports.length < 2) {
    return null
  }

  const others = ports
    .map((p) => p.port)
    .filter((port) => port !== health.port)
    .join(', ')

  return `Only port ${health.port} is checked; ${others} ${ports.length === 2 ? 'is' : 'are'} not.`
}

export const healthChangeText = (change: NonNullable<Service['last_health_change']>) => {
  if (change.status_hint === 'stopped') {
    return 'The container is not running'
  }

  if (change.status_hint === 'restarting') {
    return 'The container is restarting'
  }

  if (change.status_hint === 'asleep') {
    return 'The station is asleep'
  }

  const count = change.consecutive ? ` (${change.consecutive} in a row)` : ''

  if (change.state === 'failing') {
    return `The health check is failing${count}`
  }

  if (change.state === 'failed') {
    return `The health check has failed${count}`
  }

  if (change.state === 'passing') {
    return `The health check is passing again${count}`
  }

  return `Went from ${change.from} to ${change.to}`
}
