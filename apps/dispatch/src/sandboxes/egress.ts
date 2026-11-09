import { sandboxEgressLimits, type SandboxEgress, type SandboxEgressInput } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { invalid } from '../api/errors.ts'

type EgressInput = Static<typeof SandboxEgressInput>
type Egress = Static<typeof SandboxEgress>

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

const parsesAsDomain = (domain: string) => domain.length <= 253 && domain.split('.').every(part => label.test(part))

export const openEgress = (): Egress => ({ mode: 'open', domains: [] })

export const normalizeEgress = (input: EgressInput, path = '/egress'): Egress => {
  const issues: { path: string; message: string }[] = []
  const domains = (input.domains ?? []).map((entry, i) => {
    const domain = entry.domain.trim().toLowerCase().replace(/\.$/, '')
    if (!parsesAsDomain(domain)) issues.push({ path: `${path}/domains/${i}/domain`, message: `${entry.domain} is not a DNS name; write a wildcard as wildcard = true on the parent name` })
    const ports = [...new Set(entry.ports ?? [443])]
    return { domain, wildcard: entry.wildcard ?? false, ports }
  })
  if (domains.length > sandboxEgressLimits.domains) issues.push({ path: `${path}/domains`, message: `at most ${sandboxEgressLimits.domains} entries, got ${domains.length}` })
  const distinct = new Set(domains.flatMap(d => d.ports))
  if (distinct.size > sandboxEgressLimits.ports) issues.push({ path: `${path}/domains`, message: `at most ${sandboxEgressLimits.ports} distinct ports, got ${distinct.size}` })
  if (issues.length) invalid(issues)
  return { mode: input.mode, domains }
}
