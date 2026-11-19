import { getDomain, parse } from 'tldts'

const psl = {
  allowPrivateDomains: true,
}

export type HostnameCheck =
  { ok: true; registrable: string; commonParent: string } | { ok: false; reason: string }

const labels = (host: string) => host.split('.')

export const commonParent = (a: string, b: string) => {
  const left = labels(a).reverse()
  const right = labels(b).reverse()
  const shared: string[] = []

  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) {
    shared.push(left[i]!)
  }

  return shared.reverse().join('.')
}

export const isSuffixOf = (suffix: string, host: string) =>
  host === suffix || host.endsWith(`.${suffix}`)

export const checkHostnamePair = (dashboard: string, api: string): HostnameCheck => {
  for (const host of [dashboard, api]) {
    const parsed = parse(host, psl)

    if (parsed.isIp || !parsed.domain || parsed.hostname !== host) {
      return {
        ok: false,
        reason: `${host} is not a DNS name under a registrable domain`,
      }
    }
  }

  if (dashboard === api) {
    return {
      ok: false,
      reason: 'the dashboard and API hostnames must differ',
    }
  }

  const registrable = getDomain(dashboard, psl)

  if (!registrable || registrable !== getDomain(api, psl)) {
    return {
      ok: false,
      reason: `${dashboard} and ${api} do not share one registrable domain; use two names such as dash.alice.duckdns.org and api.alice.duckdns.org`,
    }
  }

  return {
    ok: true,
    registrable,
    commonParent: commonParent(dashboard, api),
  }
}

export const validRpId = (rpId: string, dashboard: string, api: string) => {
  const check = checkHostnamePair(dashboard, api)

  if (!check.ok) {
    return false
  }

  return isSuffixOf(rpId, dashboard) && isSuffixOf(rpId, api) && isSuffixOf(check.registrable, rpId)
}

export const oneLabelProblem = (host: string, zone: string) => {
  if (!host.endsWith(`.${zone}`)) {
    return null
  }

  const label = host.slice(0, -(zone.length + 1))

  return label.includes('.')
    ? `${host} is more than one label under ${zone}, and the free Cloudflare certificate covers only one; use a flat name such as ${label.replaceAll('.', '-')}.${zone}`
    : null
}

export const zoneHostProblem = (host: string, zone: string) => {
  if (host === zone) {
    return `${host} is the zone itself; use a name one label under it, such as dash.${zone}`
  }

  if (!host.endsWith(`.${zone}`)) {
    return `${host} is not under the zone ${zone}`
  }

  return oneLabelProblem(host, zone)
}
