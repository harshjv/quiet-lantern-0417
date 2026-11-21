import type { App } from './api'
import { plural } from './format.ts'

type Check = NonNullable<App['health']>

type Fact = [string, string]

const timing = (check: Extract<Check, { interval_s: number }>): Fact[] => [
  ['Every', `${check.interval_s} s`],
  ['Timeout', `${check.timeout_s} s`],
  ['Healthy after', plural(check.passes, 'pass', 'passes')],
  ['Failing after', plural(check.failures, 'failure')],
]

export const healthFacts = (health: App['health']): Fact[] => {
  if (!health) {
    return [['Check', 'None, judged by exit code']]
  }

  if (health.type === 'http') {
    return [
      ['Check', `HTTP GET ${health.path}`],
      ['Port', String(health.port)],
      ...(health.host ? [['Host', health.host] satisfies Fact] : []),
      ...timing(health),
    ]
  }

  if (health.type === 'tcp') {
    return [['Check', 'TCP connect'], ['Port', String(health.port)], ...timing(health)]
  }

  if (health.type === 'image') {
    return [['Check', 'The image’s HEALTHCHECK']]
  }

  return [['Check', `Running for ${health.seconds} s`]]
}

export const healthWhy = (app: Pick<App, 'kind' | 'health' | 'health_default'>) => {
  if (!app.health_default || !app.health) {
    return null
  }

  if (app.health.type === 'http') {
    return 'Default: the first HTTP port'
  }

  if (app.health.type === 'tcp') {
    return 'Default: the first port'
  }

  return app.kind === 'worker' ? 'Default: a worker has no port' : 'Default: no port'
}

export const healthPortNote = (
  health: App['health'],
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

export const healthChangeText = (change: NonNullable<App['last_health_change']>) => {
  if (change.status_hint === 'stopped') {
    return 'The container is not running'
  }

  if (change.status_hint === 'restarting') {
    return 'The container is restarting'
  }

  if (change.status_hint === 'asleep') {
    return 'The server is asleep'
  }

  const count = change.consecutive ? ` (${change.consecutive} in a row)` : ''

  if (change.state === 'failed') {
    return `The health check has failed${count}`
  }

  return `Went from ${change.from} to ${change.to}`
}
