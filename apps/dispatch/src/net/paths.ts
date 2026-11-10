export const pathVerdictValues = ['allowed', 'blocked', 'rejected'] as const

export type PathVerdict = (typeof pathVerdictValues)[number]

export const pathIdValues = [
  'same_environment',
  'resolver',
  'loopback',
  'host_address',
  'other_environment',
  'cloud_metadata',
  'private_range',
  'public_internet',
  'no_switch_target',
  'shared_service',
  'guard',
  'inbound_domain',
  'inbound_tcp',
  'inbound_other',
  'sandbox_inbound',
  'domain_not_allowed',
] as const

export type PathId = (typeof pathIdValues)[number]

export type PathScope = { subnets: string[]; resolvers: string[] }

type PathEntry = {
  path: PathId
  phase: '1a' | '1b' | 'sandbox'
  from: 'every service' | 'internet' | 'a sandbox'
  verdict: PathVerdict
  to: (scope: PathScope) => string
  rule: (scope: PathScope) => string
}

const listed = (values: string[], fallback: string) =>
  values.length ? values.join(', ') : fallback

const pathTable: PathEntry[] = [
  {
    path: 'same_environment',
    phase: '1a',
    from: 'every service',
    verdict: 'allowed',
    to: (s) => `${listed(s.subnets, 'the environment subnet')} and the environment's virtual IPs`,
    rule: (s) =>
      `ct original ip daddr @vip_targets accept, then ip daddr ${listed(s.subnets, '<env-subnet>')} accept`,
  },
  {
    path: 'resolver',
    phase: '1a',
    from: 'every service',
    verdict: 'allowed',
    to: (s) =>
      `${listed(
        s.resolvers.map((r) => `${r}:53`),
        'the resolver address on port 53',
      )} udp and tcp`,
    rule: (s) =>
      `ip daddr ${listed(s.resolvers, '<resolver-ip>')} udp dport 53 accept and the TCP twin, after the port-53 intercept`,
  },
  {
    path: 'loopback',
    phase: '1a',
    from: 'every service',
    verdict: 'allowed',
    to: () => 'its own lo',
    rule: () => 'oifname "lo" accept',
  },
  {
    path: 'host_address',
    phase: '1a',
    from: 'every service',
    verdict: 'blocked',
    to: () => "the station's own addresses, Dispatch, Depot, the Gateway",
    rule: () => 'ip daddr @host_addrs drop',
  },
  {
    path: 'other_environment',
    phase: '1a',
    from: 'every service',
    verdict: 'blocked',
    to: () => "every other environment's subnets",
    rule: () =>
      'ip daddr @private_ranges drop; the host forward chain drops the same flow between bridges as a second line',
  },
  {
    path: 'cloud_metadata',
    phase: '1a',
    from: 'every service',
    verdict: 'blocked',
    to: () => '169.254.169.254',
    rule: () => 'ip daddr @private_ranges drop',
  },
  {
    path: 'private_range',
    phase: '1a',
    from: 'every service',
    verdict: 'blocked',
    to: () => 'RFC 1918, CGNAT, loopback, link-local, multicast and reserved ranges',
    rule: () => 'ip daddr @private_ranges drop',
  },
  {
    path: 'public_internet',
    phase: '1a',
    from: 'every service',
    verdict: 'allowed',
    to: () => 'every other IPv4 destination',
    rule: () => 'ip daddr != @private_ranges accept',
  },
  {
    path: 'no_switch_target',
    phase: '1a',
    from: 'every service',
    verdict: 'rejected',
    to: () => 'a virtual IP whose service has no running deployment',
    rule: () => 'ip daddr @switch_reject reject',
  },
  {
    path: 'shared_service',
    phase: '1b',
    from: 'every service',
    verdict: 'allowed',
    to: () => "the attachment's virtual IP",
    rule: () =>
      'vip_targets entry for the alias, and ct state new dropped on consumer-side interfaces in the shared namespace',
  },
  {
    path: 'guard',
    phase: '1b',
    from: 'every service',
    verdict: 'blocked',
    to: () => 'a public destination its policy does not allow',
    rule: () => 'blocked at DNS or SNI by the Guard',
  },
  {
    path: 'inbound_domain',
    phase: '1a',
    from: 'internet',
    verdict: 'allowed',
    to: () => 'the declared http port of each service with a domain, through the Gateway',
    rule: () => "port_switch elements 80 and 443, the Gateway namespace's gateway_targets",
  },
  {
    path: 'inbound_tcp',
    phase: '1a',
    from: 'internet',
    verdict: 'allowed',
    to: () => 'each active TCP exposure',
    rule: () => "the allocation's port_switch element",
  },
  {
    path: 'inbound_other',
    phase: '1a',
    from: 'internet',
    verdict: 'blocked',
    to: () => 'everything else on the station but SSH',
    rule: () =>
      'a port absent from port_switch reaches no container; 80 and 443 are dropped while web_ports is closed',
  },
]

pathTable.push(
  {
    path: 'sandbox_inbound',
    phase: 'sandbox',
    from: 'every service',
    verdict: 'blocked',
    to: () => "a sandbox that joined the environment, or its Coupler's address",
    rule: () =>
      'iifname != "sbx" drop in the sandbox Coupler forward chain, and the inbound policy drop',
  },
  {
    path: 'domain_not_allowed',
    phase: 'sandbox',
    from: 'a sandbox',
    verdict: 'rejected',
    to: () => 'a public destination outside its allowlist, or UDP to a public destination',
    rule: () => 'the allowlist rejects in the sandbox Coupler forward chain',
  },
)

export type SandboxPaths = { inbound: boolean; allowlist: boolean }

export const environmentPaths = (
  scope: PathScope,
  sandboxes: SandboxPaths = {
    inbound: false,
    allowlist: false,
  },
) =>
  pathTable
    .filter(
      (p) =>
        p.phase === '1a' ||
        (p.path === 'sandbox_inbound' && sandboxes.inbound) ||
        (p.path === 'domain_not_allowed' && sandboxes.allowlist),
    )
    .map((p) => ({
      path: p.path,
      from: p.from,
      to: p.to(scope),
      verdict: p.verdict,
      rule: p.rule(scope),
    }))
