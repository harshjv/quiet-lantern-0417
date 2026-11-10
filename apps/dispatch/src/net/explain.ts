import { slugPattern, type MessageBody } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { eq, inArray } from 'drizzle-orm'
import { isIPv4 } from 'node:net'
import { deployment, domain, sandbox, service, service_port, station } from '../db/schema.ts'
import { fail } from '../api/errors.ts'
import type { EnvironmentRow, SandboxRow, ServiceRow } from '../api/lookup.ts'
import type { NetworkExplanation } from '../api/shapes.ts'
import { generationNumbered } from '../station/generations.ts'
import type { HopName, HopStatus, NetworkRemedy } from './explain-values.ts'
import type { NetworkFinding } from './findings.ts'
import { networkMap, type NetworkSources } from './map.ts'

export type Explanation = Static<typeof NetworkExplanation>
type Hop = Explanation['hops'][number]
type Fix = Explanation['fixes'][number]
export type Check = MessageBody<'network.inspect'>['checks'][number]
export type CheckResult = MessageBody<'network.inspect.result'>['results'][number]
type DnsEntry = MessageBody<'dns.log.result'>['entries'][number]
type Protocol = 'tcp' | 'udp'
type Json = Record<string, unknown>

export type ExplainSources = NetworkSources & {
  inspect: (stationId: string, checks: Check[]) => Promise<CheckResult[]>
  dnsLog: (stationId: string, body: MessageBody<'dns.log'>) => Promise<DnsEntry[]>
}

export type ExplainInput = { from: string; to: string; port?: number; protocol: Protocol }

const staleAfterMs = 60_000
const maxBytes = 8 * 1024

const hop = (name: HopName, status: HopStatus, detail: Json = {}, code?: NetworkFinding): Hop => ({ hop: name, status, ...(code ? { code } : {}), detail })

const fix = (code: NetworkRemedy, text: string, action?: Fix['action']): Fix => ({ code, text, ...(action ? { action } : {}) })

const targetInvalid = (explanation: string, candidates: (string | number)[], details: Json = {}): never =>
  fail('NETWORK_TARGET_INVALID', explanation, candidates.length ? `Use one of: ${candidates.join(', ')}.` : 'Give the target as a service, a .internal name, ipv4:port or hostname:port.', { candidates, ...details })

const splitPort = (to: string): [string, number | undefined] => {
  const m = /^(.+):(\d{1,5})$/.exec(to.trim())
  if (!m) return [to.trim(), undefined]
  const port = Number(m[2])
  if (port < 1 || port > 65535) targetInvalid(`${to} has a port outside 1 to 65535.`, [])
  return [m[1]!, port]
}

const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i
const slug = new RegExp(slugPattern)

const loopback = (a: string) => a.startsWith('127.') || a === '::1'
const wildcard = (a: string) => a === '0.0.0.0' || a === '::'

const serverHint = (port: number) =>
  port === 5432 ? " (for Postgres, listen_addresses = '*')" : port === 3306 ? ' (for MySQL, bind-address = 0.0.0.0)' : port === 6379 ? ' (for Redis, bind 0.0.0.0)' : ''

const probeTool = { service: 'probe_network', sandbox: 'probe_sandbox_network' } as const

type ServiceTarget = { kind: 'service'; svc: ServiceRow; vip: string; name: string | null; viaAddress: boolean; port: number }
type ContainerTarget = { kind: 'container'; svc: ServiceRow; address: string; port: number }
type AddressTarget = { kind: 'address'; address: string; port: number }
type PublicTarget = { kind: 'public'; host: string; port: number }
type MissingName = { kind: 'missing_name'; name: string; port: number | null }
type Target = ServiceTarget | ContainerTarget | AddressTarget | PublicTarget | MissingName

export const parsePortArg = (inline: number | undefined, arg: number | undefined, to: string) => {
  if (inline !== undefined && arg !== undefined && inline !== arg) targetInvalid(`${to} names port ${inline} but port is ${arg}.`, [inline])
  return inline ?? arg
}

type Origin = {
  kind: 'service' | 'sandbox'
  id: string
  name: string
  station_id: string
  ref: { service_id: string } | { sandbox_id: string }
  sandbox: SandboxRow | null
}

const idOf = (c: Check) => c.service_id ?? c.sandbox_id

const allowEntry = (egress: SandboxRow['egress'], host: string) => {
  const name = host.toLowerCase().replace(/\.$/, '')
  const exact = egress.domains.find(d => d.domain === name)
  if (exact) return exact
  return egress.domains.find(d => {
    if (!d.wildcard || !name.endsWith(`.${d.domain}`)) return false
    const prefix = name.slice(0, -(d.domain.length + 1))
    return prefix.length > 0 && prefix.split('.').length <= wildcardDepth
  })
}

const wildcardDepth = 3

export const explainNetwork = async (src: ExplainSources, env: EnvironmentRow, input: ExplainInput, now = new Date()): Promise<Explanation> => {
  const { db } = src
  const map = networkMap(src, env, { rules: false, bridges: false, now })
  const services = db.select().from(service).where(eq(service.environment_id, env.id)).all()
  const boxes = db.select().from(sandbox).where(eq(sandbox.environment_id, env.id)).all()
  const ids = services.map(s => s.id)
  const ports = ids.length ? db.select().from(service_port).where(inArray(service_port.service_id, ids)).all() : []
  const portsOf = (id: string) => ports.filter(p => p.service_id === id)
  const entryOf = (id: string) => map.services.find(s => s.id === id)
  const stationIds = [...new Set([...services.map(s => s.station_id), ...boxes.map(b => b.station_id)])]
  const stations = new Map((stationIds.length ? db.select().from(station).where(inArray(station.id, stationIds)).all() : []).map(s => [s.id, s]))
  const fresh = (id: string) => {
    const seen = stations.get(id)?.last_seen_at?.getTime() ?? 0
    return src.isConnected(id) && Boolean(src.observedOf(id)) && now.getTime() - seen <= staleAfterMs
  }
  const numberOf = (depId: string | null) => (depId ? db.select({ number: deployment.number }).from(deployment).where(eq(deployment.id, depId)).get()?.number ?? null : null)
  const named = (svc: ServiceRow) => {
    const number = stations.get(svc.station_id)?.generation ?? 0
    const doc = number ? generationNumbered(db, svc.station_id, number)?.document : undefined
    return { number, ok: Boolean(svc.current_deployment_id) && doc?.services[svc.id]?.current?.deployment_id === svc.current_deployment_id }
  }
  const startFix = (svc: ServiceRow) =>
    svc.current_deployment_id
      ? fix('START_TARGET', `Start ${svc.name}; its current deployment is not running.`, { tool: 'start_service', input: { service: svc.id } })
      : fix('DEPLOY_TARGET', `Deploy ${svc.name}; it has never had a running deployment.`, { tool: 'deploy', input: { service: svc.id } })

  const defaultPort = (svc: ServiceRow, to: string) => {
    const declared = portsOf(svc.id).map(p => p.port)
    if (declared.length === 1) return declared[0]!
    if (!declared.length) return targetInvalid(`${svc.name} declares no port, so ${to} needs one.`, [], { service: svc.name })
    return targetInvalid(`${svc.name} declares ${declared.length} ports; name one with port or ${svc.name}:<port>.`, declared, { service: svc.name })
  }

  if (input.from === 'internet') return inbound(src, env, map, services, input, fresh)

  const asService = services.find(s => s.id === input.from || s.name === input.from)
  const asSandbox = asService ? undefined : boxes.find(b => b.id === input.from || b.name === input.from)
  if (!asService && !asSandbox) return targetInvalid(`from ${input.from} is not a service or sandbox of environment ${env.name}.`, ['internet', ...services.map(s => s.name), ...boxes.map(b => b.name)], { field: 'from' })
  const source: Origin = asService
    ? { kind: 'service', id: asService.id, name: asService.name, station_id: asService.station_id, ref: { service_id: asService.id }, sandbox: null }
    : { kind: 'sandbox', id: asSandbox!.id, name: asSandbox!.name, station_id: asSandbox!.station_id, ref: { sandbox_id: asSandbox!.id }, sandbox: asSandbox! }
  const box = source.sandbox

  const target = ((): Target => {
    const [host, inline] = splitPort(input.to)
    const port = parsePortArg(inline, input.port, input.to)
    const lower = host.toLowerCase()
    if (isIPv4(host)) {
      if (port === undefined) return targetInvalid(`${input.to} is an address; give its port as ${host}:<port>.`, [])
      const byVip = map.services.find(s => s.virtual_ip === host)
      if (byVip) return { kind: 'service', svc: services.find(s => s.id === byVip.id)!, vip: host, name: null, viaAddress: true, port }
      for (const svc of services) {
        const containers = src.observedOf(svc.station_id)?.services[svc.id]?.containers ?? []
        if (containers.some(c => c.address === host)) return { kind: 'container', svc, address: host, port }
      }
      return { kind: 'address', address: host, port }
    }
    if (lower.endsWith('.internal')) {
      const labels = lower.split('.')
      const svc = labels.length === 2 ? services.find(s => s.name === labels[0]) : undefined
      if (svc) return { kind: 'service', svc, vip: entryOf(svc.id)?.virtual_ip ?? '', name: lower, viaAddress: false, port: port ?? defaultPort(svc, input.to) }
      return { kind: 'missing_name', name: lower, port: port ?? null }
    }
    if (slug.test(lower) && !lower.includes('.')) {
      const svc = services.find(s => s.name === lower || s.id === host)
      if (!svc) return targetInvalid(`${host} is not a service of environment ${env.name}.`, services.map(s => s.name))
      return { kind: 'service', svc, vip: entryOf(svc.id)?.virtual_ip ?? '', name: null, viaAddress: false, port: port ?? defaultPort(svc, input.to) }
    }
    if (host.startsWith('svc_')) {
      const svc = services.find(s => s.id === host) ?? targetInvalid(`${host} is not a service of environment ${env.name}.`, services.map(s => s.name))
      return { kind: 'service', svc, vip: entryOf(svc.id)?.virtual_ip ?? '', name: null, viaAddress: false, port: port ?? defaultPort(svc, input.to) }
    }
    if (hostnamePattern.test(host)) {
      if (port === undefined) return targetInvalid(`${input.to} is a public name; give its port as ${host}:<port>.`, [])
      return { kind: 'public', host: lower, port }
    }
    return targetInvalid(`${input.to} does not parse as a service, a .internal name, ipv4:port or hostname:port.`, services.map(s => s.name))
  })()

  const protocol = input.protocol
  const port: number = target.kind === 'missing_name' ? (target.port ?? 0) : target.port
  const toText = target.kind === 'service' ? `${target.name ?? (target.viaAddress ? target.vip : target.svc.name)}:${port}/${protocol}` : target.kind === 'container' || target.kind === 'address' ? `${target.address}:${port}/${protocol}` : target.kind === 'public' ? `${target.host}:${port}/${protocol}` : `${target.name}${target.port ? `:${target.port}` : ''}/${protocol}`
  const entity = { type: 'path' as const, from: source.name, to: toText }
  const hops: Hop[] = []
  const fixes: Fix[] = []
  const observedAt = src.observedOf(source.station_id)?.observed_at ?? null
  const notChecked = target.kind === 'public' || target.kind === 'address' ? ['whether the remote host answers; run probe_network'] : ['whether the server answers on the connection; run probe_network']

  const targetSvc = target.kind === 'service' || target.kind === 'container' ? target.svc : null
  const destination = target.kind === 'service' ? target.vip : target.kind === 'container' || target.kind === 'address' ? target.address : null

  if (!fresh(source.station_id)) {
    const st = stations.get(source.station_id)
    hops.push(hop('source', 'unknown', { station: st?.name ?? source.station_id, observed_at: observedAt }, 'STATION_STALE'))
    for (const name of ['applied', 'dns', 'firewall'] as const) hops.push(hop(name, 'unknown'))
    return finish(entity, hops, fixes, notChecked, observedAt, `Station ${st?.name ?? source.station_id} has not reported in the last 60 s, so the facts on this path are missing.`, {})
  }

  const sourceChecks: Check[] = [{ kind: 'container', ...source.ref }]
  let publicAnswer: DnsEntry | null = null
  if (target.kind === 'public') {
    const entries = await src.dnsLog(source.station_id, { ...source.ref, tail: 200, name: target.host })
    publicAnswer = entries.find(e => e.name.toLowerCase() === target.host && e.rcode === 'NOERROR' && e.answers.length > 0) ?? null
  }
  const verdictAddress = destination ?? publicAnswer?.answers[0] ?? null
  if (verdictAddress) sourceChecks.push({ kind: 'verdict', ...source.ref, address: verdictAddress, port, protocol })
  if (target.kind === 'service' && target.vip && (!box || box.network === 'environment')) sourceChecks.push({ kind: 'switch', ...source.ref, virtual_ip: target.vip })
  const targetChecks: Check[] = targetSvc ? [{ kind: 'container', service_id: targetSvc.id }, { kind: 'listening', service_id: targetSvc.id, port, protocol }] : []
  const sameStation = targetSvc && targetSvc.station_id === source.station_id
  const targetFresh = targetSvc ? fresh(targetSvc.station_id) : false
  const [sourceResults, targetResults] = await Promise.all([
    src.inspect(source.station_id, sameStation ? [...sourceChecks, ...targetChecks] : sourceChecks),
    targetSvc && !sameStation && targetFresh ? src.inspect(targetSvc.station_id, targetChecks) : Promise.resolve([] as CheckResult[])
  ])
  const results = sameStation ? sourceResults : [...sourceResults, ...targetResults]
  const checks = sameStation ? [...sourceChecks, ...targetChecks] : [...sourceChecks, ...(targetResults.length ? targetChecks : [])]
  const resultOf = (kind: Check['kind'], id?: string) => {
    const i = checks.findIndex(c => c.kind === kind && (id === undefined || idOf(c) === id))
    return i >= 0 ? results[i] : undefined
  }

  const sourceContainer = resultOf('container', source.id)
  const sourceRunning = sourceContainer && !sourceContainer.error && sourceContainer.state === 'running' && (!box || box.status === 'running')
  const sourceNumber = box ? null : numberOf(sourceContainer?.deployment_id ?? asService!.current_deployment_id)
  if (!sourceRunning) {
    hops.push(hop('source', 'fail', { [source.kind]: source.name, state: sourceContainer?.state ?? 'not running', station: stations.get(source.station_id)?.name ?? source.station_id }, 'TARGET_NOT_RUNNING'))
    fixes.push(box ? fix('START_TARGET', `Start ${box.name}; it is not running.`, { tool: 'start_sandbox', input: { sandbox: box.id } }) : startFix(asService!))
    for (const name of ['applied', 'dns', 'firewall'] as const) hops.push(hop(name, 'skipped'))
    return finish(entity, hops, fixes, notChecked, observedAt, `${source.name} is not running, so it opens no connection.`, {})
  }
  hops.push(hop('source', 'pass', { ...(box ? {} : { deployment: sourceNumber }), station: stations.get(source.station_id)?.name ?? source.station_id }))

  const sandboxApplied = () => {
    const number = stations.get(source.station_id)?.generation ?? 0
    const doc = number ? generationNumbered(db, source.station_id, number)?.document : undefined
    return { number, ok: Boolean(doc?.sandboxes?.[source.id]) }
  }
  const sourceApplied = box ? sandboxApplied() : named(asService!)
  const targetApplied = targetSvc ? named(targetSvc) : { number: sourceApplied.number, ok: true }
  if (sourceApplied.ok && (!targetSvc || targetApplied.ok || !targetSvc.current_deployment_id)) hops.push(hop('applied', 'pass', { generation: sourceApplied.number }))
  else {
    const late = !sourceApplied.ok ? source : targetSvc!
    hops.push(hop('applied', 'fail', { generation: sourceApplied.number, service: late.name }, 'SWITCH_PENDING'))
    fixes.push(fix('WAIT_FOR_APPLY', `The station has not applied the generation that names ${late.name}'s current deployment yet; wait a few seconds and explain again.`))
  }

  const isolated = Boolean(box && box.network !== 'environment')
  const joinFix = () => fix('JOIN_ENVIRONMENT', `${source.name} is isolated, so its resolver answers NXDOMAIN for every .internal name. Create it with network = environment, or change network while it is stopped and start it again.`, { tool: 'update_sandbox', input: { sandbox: source.id, network: 'environment' } })
  const skipFrom = (names: readonly HopName[]) => names.map(name => hop(name, 'skipped'))

  switch (target.kind) {
    case 'service':
      if (isolated && !target.viaAddress) {
        hops.push(hop('dns', 'fail', { name: target.name ?? `${target.svc.name}.internal`, sandbox: source.name, network: 'isolated', rcode: 'NXDOMAIN' }, 'NAME_NOT_IN_ENVIRONMENT'))
        fixes.push(joinFix())
        hops.push(...skipFrom(['firewall', 'switch', 'target', 'listening']))
        return finish(entity, hops, fixes, notChecked, observedAt, `${source.name} is isolated, so ${target.name ?? `${target.svc.name}.internal`} is NXDOMAIN for it.`, {})
      }
      hops.push(target.viaAddress ? hop('dns', 'skipped', { reason: 'an address was given' }) : hop('dns', 'pass', { name: target.name ?? `${target.svc.name}.internal`, answer: target.vip }))
      break
    case 'container':
    case 'address':
      hops.push(hop('dns', 'skipped', { reason: 'an address was given' }))
      break
    case 'public':
      if (box?.egress.mode === 'allowlist') {
        const entry = allowEntry(box.egress, target.host)
        if (!entry || !entry.ports.includes(port)) {
          const listed = box.egress.domains.map(d => ({ domain: d.domain, wildcard: d.wildcard, ports: d.ports }))
          const next = entry
            ? box.egress.domains.map(d => (d === entry ? { ...d, ports: [...d.ports, port] } : d))
            : [...box.egress.domains, { domain: target.host, wildcard: false, ports: [port] }]
          hops.push(hop('dns', 'skipped', { reason: 'the resolver refuses a name the allowlist does not list' }))
          hops.push(hop('allowlist', 'fail', { mode: 'allowlist', name: target.host, port, matched: entry?.domain ?? null, listed: listed.slice(0, 16), entries: listed.length }, 'DOMAIN_NOT_ALLOWED'))
          fixes.push(fix('ALLOW_DOMAIN', entry ? `${entry.domain} is listed without port ${port}; add the port to its entry.` : `Add ${target.host}:${port} to ${source.name}'s allowlist.`, { tool: 'update_sandbox', input: { sandbox: source.id, egress: { mode: 'allowlist', domains: next.map(d => ({ domain: d.domain, wildcard: d.wildcard, ports: d.ports })) } } }))
          hops.push(...skipFrom(['firewall']))
          return finish(entity, hops, fixes, notChecked, observedAt, entry ? `${target.host} is on ${source.name}'s allowlist but not on port ${port}, so connections to it are rejected.` : `${target.host} is not on ${source.name}'s allowlist, so its resolver answers NXDOMAIN and never forwards the query.`, { path: 'domain_not_allowed' })
        }
        hops.push(publicAnswer ? hop('dns', 'pass', { name: target.host, answer: publicAnswer.answers[0], at: publicAnswer.at }) : hop('dns', 'unknown', { name: target.host, reason: `${source.name} has no answer for ${target.host} in its DNS log` }))
        hops.push(hop('allowlist', 'pass', { mode: 'allowlist', matched: entry.domain, wildcard: entry.wildcard, ports: entry.ports }))
        break
      }
      hops.push(publicAnswer ? hop('dns', 'pass', { name: target.host, answer: publicAnswer.answers[0], at: publicAnswer.at }) : hop('dns', 'unknown', { name: target.host, reason: `${source.name} has no answer for ${target.host} in its DNS log` }))
      break
    case 'missing_name': {
      hops.push(hop('dns', 'fail', { name: target.name, environment: env.name, rcode: 'NXDOMAIN' }, 'NAME_NOT_IN_ENVIRONMENT'))
      const names = services.map(s => `${s.name}.internal`)
      if (isolated) fixes.push(joinFix())
      else fixes.push(fix('USE_INTERNAL_NAME', `${target.name} is not a service of ${env.name}; the resolver answers only <service>.internal for the services of ${source.name}'s own environment. Names here: ${names.slice(0, 5).join(', ')}.`))
      for (const name of ['firewall', 'switch', 'target', 'listening'] as const) hops.push(hop(name, 'skipped'))
      return finish(entity, hops, fixes, notChecked, observedAt, `${target.name} is not a name in environment ${env.name}, so the resolver answers NXDOMAIN.`, {})
    }
  }

  const verdict = resultOf('verdict', source.id)
  let blockedPath: string | null = null
  if (!verdict) hops.push(hop('firewall', 'unknown', { reason: `no address to judge for ${target.kind === 'public' ? target.host : toText}` }))
  else if (verdict.error) hops.push(hop('firewall', 'unknown', { error: verdict.error }))
  else if (verdict.verdict === 'accept') hops.push(hop('firewall', 'pass', { path: verdict.path, rule: verdict.rule }))
  else if (verdict.verdict === 'reject') hops.push(hop('firewall', 'warn', { path: verdict.path, rule: verdict.rule, verdict: 'reject' }))
  else {
    blockedPath = verdict.path ?? null
    hops.push(hop('firewall', 'fail', { path: verdict.path, rule: verdict.rule, address: verdictAddress, port, protocol }, 'PATH_BLOCKED'))
  }

  if (target.kind === 'public' || target.kind === 'address') {
    if (verdict?.verdict === 'accept' && verdict.path === 'public_internet') {
      hops.push(hop('probe_required', 'unknown', { reason: 'whether a remote host answers is a live fact' }))
      fixes.push(fix('RUN_PROBE', `Probe ${target.kind === 'public' ? target.host : target.address}:${port} from ${source.name} to see whether it answers.`, { tool: probeTool[source.kind], input: { [source.kind]: source.id, to: target.kind === 'public' ? target.host : target.address, port } }))
    } else if (verdict?.verdict === 'accept') {
      hops.push(hop('target', 'fail', { address: verdictAddress, reason: 'no container of this environment holds the address' }, 'TARGET_NOT_RUNNING'))
    } else if (!verdict) {
      hops.push(hop('probe_required', 'unknown', { reason: 'the DNS log has no answer to judge' }))
      fixes.push(fix('RUN_PROBE', `Probe ${toText.split('/')[0]} from ${source.name}; it resolves the name and connects under the service's own rules.`, { tool: probeTool[source.kind], input: { [source.kind]: source.id, to: target.kind === 'public' ? target.host : verdictAddress, port } }))
    }
    const summary = blockedPath ? blockedSummary(source.name, verdictAddress!, port, blockedPath, verdict!.rule ?? '') : !verdict ? `${source.name} has not resolved ${target.kind === 'public' ? target.host : toText} yet, so the path cannot be judged without a probe.` : `The rules let ${source.name} reach ${verdictAddress}:${port}; only a probe shows whether it answers.`
    return finish(entity, hops, fixes, notChecked, observedAt, summary, blockedPath ? { path: blockedPath } : {})
  }

  const svc = target.svc
  const containerResult = targetResults.length || sameStation ? resultOf('container', svc.id) : undefined
  const targetRunning = Boolean(containerResult && !containerResult.error && containerResult.state === 'running')
  const targetAddress = containerResult?.address ?? null
  const targetNumber = numberOf(containerResult?.deployment_id ?? svc.current_deployment_id)

  if (target.kind === 'service') {
    const sw = box && box.network !== 'environment' ? undefined : resultOf('switch', source.id)
    if (!sw || sw.error) hops.push(hop('switch', 'unknown', { virtual_ip: target.vip, error: sw?.error ?? 'not read' }))
    else if (!sw.address) {
      hops.push(hop('switch', 'fail', { virtual_ip: target.vip, address: null, rejected: Boolean(sw.rejected) }, 'SWITCH_NO_TARGET'))
      fixes.push(startFix(svc))
    } else if (targetAddress && sw.address !== targetAddress) {
      hops.push(hop('switch', 'fail', { virtual_ip: target.vip, address: sw.address, expected: targetAddress, deployment: targetNumber }, 'SWITCH_MISMATCH'))
    } else hops.push(hop('switch', 'pass', { virtual_ip: target.vip, address: sw.address, deployment: targetNumber }))
  } else hops.push(hop('switch', 'skipped', { reason: 'a container address bypasses the Switch' }))

  if (!targetFresh) hops.push(hop('target', 'unknown', { station: stations.get(svc.station_id)?.name ?? svc.station_id }, 'STATION_STALE'))
  else if (!targetRunning) {
    hops.push(hop('target', 'fail', { service: svc.name, state: containerResult?.state ?? 'not running' }, 'TARGET_NOT_RUNNING'))
    if (!fixes.some(f => f.code === 'START_TARGET' || f.code === 'DEPLOY_TARGET')) fixes.push(startFix(svc))
  } else if (containerResult!.health === 'failing') {
    const last = src.observedOf(svc.station_id)?.services[svc.id]?.health
    hops.push(hop('target', 'fail', { state: 'running', health: 'failing', last_check: last?.last_check ?? null, consecutive: last?.consecutive ?? null }, 'TARGET_UNHEALTHY'))
  } else hops.push(hop('target', containerResult!.health === 'starting' ? 'warn' : 'pass', { state: 'running', health: containerResult!.health ?? 'none' }))

  const listening = resultOf('listening', svc.id)
  let listeningSummary: string | null = null
  if (!targetRunning || !listening) hops.push(hop('listening', 'skipped'))
  else if (listening.error) hops.push(hop('listening', 'unknown', { error: listening.error }))
  else {
    const sockets = listening.sockets ?? []
    const onPort = sockets.filter(s => s.port === port && s.protocol === protocol)
    if (onPort.some(s => wildcard(s.address) || s.address === targetAddress)) hops.push(hop('listening', 'pass', { listening: onPort }))
    else if (onPort.length && onPort.every(s => loopback(s.address))) {
      hops.push(hop('listening', 'fail', { listening: onPort }, 'LISTENING_LOOPBACK_ONLY'))
      fixes.push(fix('BIND_ALL_INTERFACES', `Make the server listen on 0.0.0.0:${port}${serverHint(port)}, then redeploy ${svc.name}.`))
      listeningSummary = `${svc.name} listens on ${onPort[0]!.address}:${port} only, so no other service can reach it.`
    } else {
      hops.push(hop('listening', 'fail', { listening: sockets.slice(0, 16) }, 'NOT_LISTENING'))
      const others = [...new Set(sockets.filter(s => s.protocol === protocol && !loopback(s.address)).map(s => s.port))]
      fixes.push(fix('USE_DECLARED_PORT', others.length ? `${svc.name} listens on ${others.join(', ')}/${protocol}, not ${port}. Connect to the port the server uses, or make it listen on ${port}.` : `Nothing in ${svc.name} listens on ${port}/${protocol}. Check the server's port setting and its logs.`))
      listeningSummary = others.length ? `Nothing in ${svc.name} listens on ${port}/${protocol}; it listens on ${others.join(', ')}.` : `Nothing in ${svc.name} listens on ${port}/${protocol}.`
    }
  }

  const declared = portsOf(svc.id).some(p => p.port === port)
  if (declared) hops.push(hop('port', 'pass', { declared: true }))
  else {
    hops.push(hop('port', 'warn', { declared: false }, 'PORT_NOT_DECLARED'))
    fixes.push(fix('DECLARE_PORT', `Declare port ${port} on ${svc.name} so domains and TCP exposures can use it; internal traffic reaches it already.`))
  }

  const failed = hops.find(h => h.status === 'fail' || h.status === 'unknown')
  if (!failed) fixes.unshift(fix('RUN_PROBE', `Probe ${toText.split('/')[0]} from ${source.name} to see whether the server answers.`, { tool: probeTool[source.kind], input: { [source.kind]: source.id, to: target.kind === 'service' ? (target.name ?? (target.viaAddress ? target.vip : `${svc.name}.internal`)) : target.address, port } }))
  const summary = (() => {
    if (!failed) return `${source.name} can reach ${svc.name} on ${port}/${protocol}: every hop passed. Only a probe shows whether the server answers.`
    switch (failed.code) {
      case 'PATH_BLOCKED':
        return blockedSummary(source.name, verdictAddress!, port, blockedPath!, verdict?.rule ?? '')
      case 'SWITCH_NO_TARGET':
        return `${svc.name} has no running deployment, so its virtual IP ${target.kind === 'service' ? target.vip : ''} rejects connections.`
      case 'SWITCH_MISMATCH':
        return `${source.name}'s Switch entry for ${svc.name} points at ${(failed.detail as Json).address}, which no container of deployment #${targetNumber} holds.`
      case 'SWITCH_PENDING':
        return `The station has not applied the generation that names ${(failed.detail as Json).service}'s current deployment.`
      case 'TARGET_NOT_RUNNING':
        return `${svc.name} has no running container.`
      case 'TARGET_UNHEALTHY':
        return `${svc.name} is running but its health check is failing.`
      case 'LISTENING_LOOPBACK_ONLY':
      case 'NOT_LISTENING':
        return listeningSummary!
      case 'STATION_STALE':
        return `Station ${stations.get(svc.station_id)?.name ?? svc.station_id} has not reported in the last 60 s, so ${svc.name}'s facts are missing.`
    }
    return `The path from ${source.name} to ${svc.name} fails at ${failed.hop}.`
  })()
  return finish(entity, hops, fixes, notChecked, observedAt, summary, blockedPath ? { path: blockedPath } : {})
}

const blockedSummary = (from: string, address: string, port: number, path: string, rule: string) => `${from} cannot reach ${address}:${port}: path ${path} is blocked by ${rule}.`

const finish = (entity: Explanation['entity'], hops: Hop[], fixes: Fix[], notChecked: string[], observedAt: string | null, summary: string, details: Json): Explanation => {
  const failed = hops.find(h => h.status === 'fail' || h.status === 'unknown')
  const verdict: Explanation['verdict'] = !failed ? 'reachable' : failed.status === 'unknown' ? 'unknown' : failed.hop === 'firewall' || failed.hop === 'allowlist' || failed.code === 'WEB_PORTS_CLOSED' ? 'blocked' : 'broken'
  const doc: Explanation = {
    entity,
    verdict,
    phase: failed?.hop ?? null,
    code: failed?.code ?? null,
    summary,
    ...(Object.keys(details).length ? { details } : {}),
    hops,
    fixes,
    not_checked: notChecked,
    observed_at: observedAt
  }
  for (const h of doc.hops) {
    if (Buffer.byteLength(JSON.stringify(doc)) <= maxBytes) break
    const list = (h.detail as Json).listening
    if (Array.isArray(list) && list.length > 4) (h.detail as Json).listening = list.slice(0, 4)
  }
  return doc
}

const inbound = async (
  src: ExplainSources,
  env: EnvironmentRow,
  map: ReturnType<typeof networkMap>,
  services: ServiceRow[],
  input: ExplainInput,
  fresh: (stationId: string) => boolean
): Promise<Explanation> => {
  const { db } = src
  const to = input.to.trim().toLowerCase()
  const domains = map.services.flatMap(s => s.domains.map(d => ({ entry: s, d })))
  const exposures = map.services.flatMap(s => s.exposures.map(x => ({ entry: s, x })))
  const hops: Hop[] = []
  const fixes: Fix[] = []
  const stationRow = (id: string) => db.select().from(station).where(eq(station.id, id)).get()
  const found = domains.find(({ d }) => d.hostname.toLowerCase() === to)
  const [host, hostPort] = splitPort(to)
  const exposure = !found && isIPv4(host) && hostPort ? exposures.find(({ x }) => x.host_port === hostPort && (x.public === `${host}:${hostPort}` || !x.public)) : undefined
  if (!found && !exposure) targetInvalid(`${input.to} is not a domain or TCP exposure of environment ${env.name}.`, [...domains.map(({ d }) => d.hostname), ...exposures.map(({ x }) => x.public ?? `<public address>:${x.host_port}`)], { from: 'internet' })
  const entry = (found?.entry ?? exposure!.entry)!
  const svc = services.find(s => s.id === entry.id)!
  const st = stationRow(svc.station_id)
  const port = found ? found.d.port : exposure!.x.port
  const protocol = 'tcp' as const
  const entity = { type: 'path' as const, from: 'internet', to: `${found ? found.d.hostname : `${host}:${hostPort}`}/${protocol}` }
  const observedAt = src.observedOf(svc.station_id)?.observed_at ?? null
  const notChecked = found
    ? [`the public DNS record for ${found.d.hostname}; check that it points at ${st?.public_address ?? 'the station'}`, 'whether the server answers a request through the Gateway']
    : ['whether a client on the internet has a route to the station', 'whether the server answers on the connection']

  if (!fresh(svc.station_id)) {
    hops.push(hop(found ? 'domain' : 'exposure', 'unknown', { station: st?.name ?? svc.station_id, observed_at: observedAt }, 'STATION_STALE'))
    return finish(entity, hops, fixes, notChecked, observedAt, `Station ${st?.name ?? svc.station_id} has not reported in the last 60 s, so the facts on this path are missing.`, {})
  }
  const vip = entry.virtual_ip
  const checks: Check[] = [
    found ? { kind: 'host_switch', virtual_ip: vip ?? '', port } : { kind: 'host_switch', host_port: hostPort },
    { kind: 'container', service_id: svc.id },
    { kind: 'listening', service_id: svc.id, port, protocol }
  ]
  const [hs, container, listening] = await src.inspect(svc.station_id, checks)
  const running = Boolean(container && !container.error && container.state === 'running')
  const address = container?.address ?? null

  let summary: string | null = null
  if (found) {
    const d = found.d
    const record = `an A record for ${d.hostname} pointing at ${st?.public_address ?? "the station's public address"}`
    if (d.status === 'active') hops.push(hop('domain', 'pass', { hostname: d.hostname, status: d.status, ingress: d.ingress }))
    else {
      const error = db.select({ error: domain.error }).from(domain).where(eq(domain.id, d.id)).get()?.error ?? null
      hops.push(hop('domain', d.status === 'pending' ? 'warn' : 'fail', { hostname: d.hostname, status: d.status, ingress: d.ingress, error }, 'DOMAIN_NOT_ACTIVE'))
      fixes.push(fix('CHECK_DNS_RECORD', `Create ${record}, then wait for the domain probe.`))
      if (d.status !== 'pending') summary ??= `${d.hostname} is ${d.status}.`
    }
    if (st?.public_address) hops.push(hop('public_address', 'pass', { address: st.public_address }))
    else {
      hops.push(hop('public_address', 'fail', { station: st?.name ?? svc.station_id }, 'NO_PUBLIC_ADDRESS'))
      fixes.push(fix('SET_PUBLIC_ADDRESS', `Set the station's public address: sly stations update ${st?.name ?? svc.station_id} --public-address <ipv4>.`))
      summary ??= `Station ${st?.name ?? svc.station_id} has no public address.`
    }
    if (map.inbound.web_ports === 'open') hops.push(hop('web_ports', 'pass', { web_ports: 'open' }))
    else {
      hops.push(hop('web_ports', 'fail', { web_ports: 'closed', path: 'inbound_other' }, 'WEB_PORTS_CLOSED'))
      fixes.push(fix('ADD_DOMAIN', 'Inbound 80 and 443 open once the station has a direct route: add a direct domain on this station (ingress = direct). Tunnel ingress arrives in phase 1b.'))
      summary ??= `The station has no direct route, so inbound 80 and 443 are dropped and ${d.hostname} is unreachable from the internet.`
    }
    if (d.ingress !== 'direct') hops.push(hop('certificate', 'skipped', { reason: 'tunnel ingress' }))
    else if (d.certificate.status === 'valid') hops.push(hop('certificate', 'pass', { status: 'valid', expires_at: d.certificate.expires_at }))
    else {
      hops.push(hop('certificate', 'fail', { status: d.certificate.status }, 'CERTIFICATE_NOT_VALID'))
      summary ??= `${d.hostname} has no valid certificate (status ${d.certificate.status}).`
    }
    if (d.route.result === 'ok' && hs && !hs.error && hs.gateway_target) hops.push(hop('route', 'pass', { entrypoint: d.route.entrypoint, target: d.route.target, result: d.route.result, gateway_target: true }))
    else {
      hops.push(hop('route', 'fail', { entrypoint: d.route.entrypoint, target: d.route.target, result: d.route.result, gateway_target: hs?.gateway_target ?? null, error: hs?.error ?? null }, 'ROUTE_NOT_APPLIED'))
      summary ??= `The Gateway route for ${d.hostname} is not applied on the station.`
    }
    if (!hs || hs.error) hops.push(hop('switch', 'unknown', { virtual_ip: vip, error: hs?.error ?? 'not read' }))
    else if (!hs.address) {
      hops.push(hop('switch', 'fail', { virtual_ip: vip, address: null }, 'SWITCH_NO_TARGET'))
      fixes.push(startFixFor(svc))
      summary ??= `${svc.name} has no running deployment, so the Gateway's Switch element for ${vip} is empty.`
    } else if (address && hs.address !== address) {
      hops.push(hop('switch', 'fail', { virtual_ip: vip, address: hs.address, expected: address }, 'SWITCH_MISMATCH'))
      summary ??= `The Gateway's Switch element for ${svc.name} points at ${hs.address}, not ${address}.`
    } else hops.push(hop('switch', 'pass', { virtual_ip: vip, address: hs.address }))
  } else {
    const x = exposure!.x
    if (x.status === 'active' && (x.result === 'ok' || x.result === null)) hops.push(hop('exposure', 'pass', { host_port: x.host_port, status: x.status, result: x.result }))
    else {
      hops.push(hop('exposure', 'fail', { host_port: x.host_port, status: x.status, result: x.result }, 'ROUTE_NOT_APPLIED'))
      summary ??= `The TCP exposure on host port ${x.host_port} is ${x.status}${x.result ? ` (${x.result})` : ''}.`
    }
    if (st?.public_address) hops.push(hop('public_address', 'pass', { address: st.public_address }))
    else {
      hops.push(hop('public_address', 'fail', { station: st?.name ?? svc.station_id }, 'NO_PUBLIC_ADDRESS'))
      fixes.push(fix('SET_PUBLIC_ADDRESS', `Set the station's public address: sly stations update ${st?.name ?? svc.station_id} --public-address <ipv4>.`))
      summary ??= `Station ${st?.name ?? svc.station_id} has no public address.`
    }
    const want = address ? `${address}:${port}` : null
    const have = hs && !hs.error && hs.address ? `${hs.address}:${hs.port}` : null
    if (have && (!want || have === want)) hops.push(hop('route', 'pass', { host_port: x.host_port, target: have }))
    else {
      hops.push(hop('route', 'fail', { host_port: x.host_port, target: have, expected: want, error: hs?.error ?? null }, have ? 'ROUTE_NOT_APPLIED' : running ? 'ROUTE_NOT_APPLIED' : 'SWITCH_NO_TARGET'))
      if (!running) fixes.push(startFixFor(svc))
      summary ??= have ? `Host port ${x.host_port} points at ${have}, not ${want}.` : `Host port ${x.host_port} has no port_switch element on the station.`
    }
  }

  if (!running) {
    hops.push(hop('target', 'fail', { service: svc.name, state: container?.state ?? 'not running' }, 'TARGET_NOT_RUNNING'))
    if (!fixes.some(f => f.code === 'START_TARGET' || f.code === 'DEPLOY_TARGET')) fixes.push(startFixFor(svc))
    summary ??= `${svc.name} has no running container.`
    hops.push(hop('listening', 'skipped'))
  } else {
    hops.push(container!.health === 'failing' ? hop('target', 'fail', { state: 'running', health: 'failing' }, 'TARGET_UNHEALTHY') : hop('target', 'pass', { state: 'running', health: container!.health ?? 'none' }))
    if (container!.health === 'failing') summary ??= `${svc.name} is running but its health check is failing.`
    const sockets = listening?.sockets ?? []
    const onPort = sockets.filter(s => s.port === port && s.protocol === protocol)
    if (!listening || listening.error) hops.push(hop('listening', 'unknown', { error: listening?.error ?? 'not read' }))
    else if (onPort.some(s => wildcard(s.address) || s.address === address)) hops.push(hop('listening', 'pass', { listening: onPort }))
    else if (onPort.length && onPort.every(s => loopback(s.address))) {
      hops.push(hop('listening', 'fail', { listening: onPort }, 'LISTENING_LOOPBACK_ONLY'))
      fixes.push(fix('BIND_ALL_INTERFACES', `Make the server listen on 0.0.0.0:${port}${serverHint(port)}, then redeploy ${svc.name}.`))
      summary ??= `${svc.name} listens on ${onPort[0]!.address}:${port} only, so the Gateway cannot reach it.`
    } else {
      hops.push(hop('listening', 'fail', { listening: sockets.slice(0, 16) }, 'NOT_LISTENING'))
      fixes.push(fix('USE_DECLARED_PORT', `Nothing in ${svc.name} listens on ${port}/tcp; make the server listen on the declared port.`))
      summary ??= `Nothing in ${svc.name} listens on ${port}/tcp.`
    }
  }
  summary ??= `The internet can reach ${svc.name} through ${found ? found.d.hostname : `${host}:${hostPort}`}: every hop passed.`
  return finish(entity, hops, fixes, notChecked, observedAt, summary, {})
}

const startFixFor = (svc: ServiceRow) =>
  svc.current_deployment_id
    ? fix('START_TARGET', `Start ${svc.name}; its current deployment is not running.`, { tool: 'start_service', input: { service: svc.id } })
    : fix('DEPLOY_TARGET', `Deploy ${svc.name}; it has never had a running deployment.`, { tool: 'deploy', input: { service: svc.id } })

export const probeTarget = (db: ExplainSources['db'], env: EnvironmentRow, to: string, portArg: number | undefined, kind: 'tcp' | 'dns') => {
  const [host, inline] = splitPort(to)
  const port = parsePortArg(inline, portArg, to)
  const lower = host.toLowerCase()
  const services = db.select().from(service).where(eq(service.environment_id, env.id)).all()
  if (isIPv4(host)) {
    if (kind === 'dns') return targetInvalid(`A DNS probe asks for a name; ${host} is an address.`, [])
    if (port === undefined) return targetInvalid(`${to} is an address; give its port as ${host}:<port>.`, [])
    return { to: host, port }
  }
  const declaredPort = (svcId: string, name: string) => {
    if (port !== undefined || kind === 'dns') return port ?? null
    const declared = db.select({ port: service_port.port }).from(service_port).where(eq(service_port.service_id, svcId)).all().map(p => p.port)
    if (declared.length === 1) return declared[0]!
    if (!declared.length) return targetInvalid(`${name} declares no port, so the probe needs one.`, [])
    return targetInvalid(`${name} declares ${declared.length} ports; name one with port.`, declared)
  }
  if (lower.endsWith('.internal')) {
    const labels = lower.split('.')
    if (labels.length !== 2 || !labels[0]) return targetInvalid(`${to} is not a <service>.internal name.`, services.map(s => `${s.name}.internal`))
    const svc = services.find(s => s.name === labels[0])
    const p = svc ? declaredPort(svc.id, svc.name) : (port ?? null)
    if (kind === 'tcp' && p === null) return targetInvalid(`${to} needs a port.`, [])
    return { to: lower, port: p }
  }
  if (slug.test(lower) || host.startsWith('svc_')) {
    const svc = services.find(s => s.name === lower || s.id === host) ?? targetInvalid(`${host} is not a service of environment ${env.name}.`, services.map(s => s.name))
    return { to: `${svc.name}.internal`, port: declaredPort(svc.id, svc.name) }
  }
  if (hostnamePattern.test(host)) {
    if (kind === 'tcp' && port === undefined) return targetInvalid(`${to} is a public name; give its port as ${host}:<port>.`, [])
    return { to: lower, port: port ?? null }
  }
  return targetInvalid(`${to} does not parse as a service, a .internal name, ipv4:port or hostname:port.`, services.map(s => s.name))
}

