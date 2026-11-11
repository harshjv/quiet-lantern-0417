import { isIPv4 } from 'node:net'

import { getDomain, parse } from 'tldts'

const psl = {
  allowPrivateDomains: true,
}

export type PairCheck = { ok: true; parent: string } | { ok: false; reason: string }

const commonParent = (a: string, b: string) => {
  const left = a.split('.').reverse()
  const right = b.split('.').reverse()
  const shared: string[] = []

  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) {
    shared.push(left[i]!)
  }

  return shared.reverse().join('.')
}

export const checkPair = (api: string, dashboard: string): PairCheck => {
  for (const host of [api, dashboard]) {
    const parsed = parse(host, psl)

    if (parsed.isIp || !parsed.domain || parsed.hostname !== host) {
      return {
        ok: false,
        reason: `${host} is not a DNS name under a registrable domain`,
      }
    }
  }

  if (api === dashboard) {
    return {
      ok: false,
      reason: 'the API and dashboard hostnames must differ',
    }
  }

  const registrable = getDomain(api, psl)

  if (!registrable || registrable !== getDomain(dashboard, psl)) {
    return {
      ok: false,
      reason: `${api} and ${dashboard} do not share one registrable domain (Public Suffix List); use two names such as api.alice.duckdns.org and dash.alice.duckdns.org`,
    }
  }

  return {
    ok: true,
    parent: commonParent(api, dashboard),
  }
}

export const siblingSuggestion = (api: string, label: string) => {
  const dot = api.indexOf('.')

  return dot > 0 ? `${label}.${api.slice(dot + 1)}` : ''
}

export const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

const privateOrLoopback = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

export const endpointProblem = (value: string) => {
  if (!value || value.startsWith('https://')) {
    return null
  }

  const host = /^http:\/\/([^/:@]+)(:\d+)?(\/.*)?$/.exec(value)?.[1]

  return host && isIPv4(host) && privateOrLoopback.test(host)
    ? null
    : 'the endpoint is an https URL, or an http URL on a private or loopback address'
}

export const ipv4Problem = (value: string) =>
  isIPv4(value) ? null : 'that is not an IPv4 address in dotted-quad form'
