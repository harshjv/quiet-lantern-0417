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
  'shared_app',
  'guard',
  'inbound_domain',
  'inbound_tcp',
  'inbound_other',
  'sandbox_inbound',
  'domain_not_allowed',
  'credentials_proxy',
  'credential_quic',
] as const

export type PathId = (typeof pathIdValues)[number]

export type PathScope = { subnets: string[]; resolvers: string[] }

type PathEntry = {
  path: PathId
  phase: '1a' | '1b' | 'machine'
  from: 'every app' | 'internet' | 'a machine'
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
    from: 'every app',
    verdict: 'allowed',
    to: (s) =>
      `${listed(s.subnets, 'the subnet')} and the virtual IPs of the same production or preview`,
    rule: (s) =>
      `ct original ip daddr @vip_targets accept, then ip daddr ${listed(s.subnets, '<env-subnet>')} accept`,
  },
  {
    path: 'resolver',
    phase: '1a',
    from: 'every app',
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
    from: 'every app',
    verdict: 'allowed',
    to: () => 'its own lo',
    rule: () => 'oifname "lo" accept',
  },
  {
    path: 'host_address',
    phase: '1a',
    from: 'every app',
    verdict: 'blocked',
    to: () => "the server's own addresses, Dispatch, Depot, the Gateway",
    rule: () => 'ip daddr @host_addrs drop',
  },
  {
    path: 'other_environment',
    phase: '1a',
    from: 'every app',
    verdict: 'blocked',
    to: () => 'the subnets of every other production and preview',
    rule: () =>
      'ip daddr @private_ranges drop; the host forward chain drops the same flow between bridges as a second line',
  },
  {
    path: 'cloud_metadata',
    phase: '1a',
    from: 'every app',
    verdict: 'blocked',
    to: () => '169.254.169.254',
    rule: () => 'ip daddr @private_ranges drop',
  },
  {
    path: 'private_range',
    phase: '1a',
    from: 'every app',
    verdict: 'blocked',
    to: () => 'RFC 1918, CGNAT, loopback, link-local, multicast and reserved ranges',
    rule: () => 'ip daddr @private_ranges drop',
  },
  {
    path: 'public_internet',
    phase: '1a',
    from: 'every app',
    verdict: 'allowed',
    to: () => 'every other IPv4 destination',
    rule: () => 'ip daddr != @private_ranges accept',
  },
  {
    path: 'no_switch_target',
    phase: '1a',
    from: 'every app',
    verdict: 'rejected',
    to: () => 'a virtual IP whose app has no running deployment',
    rule: () => 'ip daddr @switch_reject reject',
  },
  {
    path: 'shared_app',
    phase: '1b',
    from: 'every app',
    verdict: 'allowed',
    to: () => "the attachment's virtual IP",
    rule: () =>
      'vip_targets entry for the alias, and ct state new dropped on consumer-side interfaces in the shared namespace',
  },
  {
    path: 'guard',
    phase: '1b',
    from: 'every app',
    verdict: 'blocked',
    to: () => 'a public destination its policy does not allow',
    rule: () => 'blocked at DNS or SNI by the Guard',
  },
  {
    path: 'inbound_domain',
    phase: '1a',
    from: 'internet',
    verdict: 'allowed',
    to: () => 'the declared http port of each app with a domain, through the Gateway',
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
    to: () => 'everything else on the server but SSH',
    rule: () =>
      'a port absent from port_switch reaches no container; 80 and 443 are dropped while web_ports is closed',
  },
]

pathTable.push(
  {
    path: 'sandbox_inbound',
    phase: 'machine',
    from: 'every app',
    verdict: 'blocked',
    to: () => "a machine that joined the network, or its Coupler's address",
    rule: () =>
      'iifname != "sbx" drop in the machine Coupler forward chain, and the inbound policy drop',
  },
  {
    path: 'domain_not_allowed',
    phase: 'machine',
    from: 'a machine',
    verdict: 'rejected',
    to: () => 'a public destination outside its allowlist, or UDP to a public destination',
    rule: () => 'the allowlist rejects in the machine Coupler forward chain',
  },
  {
    path: 'credentials_proxy',
    phase: 'machine',
    from: 'a machine',
    verdict: 'allowed',
    to: () =>
      "TCP 443 to a credential host's address, redirected to stationd's credentials proxy, which swaps placeholders for that host and passes any other name through",
    rule: () =>
      'the credentials DNAT to 169.254.1.1:7443 in the machine Coupler prerouting, and the 7443 accept for redirected connections in inbound',
  },
  {
    path: 'credential_quic',
    phase: 'machine',
    from: 'a machine',
    verdict: 'rejected',
    to: () => "UDP 443 to a credential host's address, so QUIC falls back to TCP and the proxy",
    rule: () =>
      'ip daddr @credential_hosts_443 udp dport 443 reject in the machine Coupler forward chain',
  },
)

export type MachinePaths = { inbound: boolean; allowlist: boolean; credentials: boolean }

export const environmentPaths = (
  scope: PathScope,
  machines: MachinePaths = {
    inbound: false,
    allowlist: false,
    credentials: false,
  },
) =>
  pathTable
    .filter(
      (p) =>
        p.phase === '1a' ||
        (p.path === 'sandbox_inbound' && machines.inbound) ||
        (p.path === 'domain_not_allowed' && machines.allowlist) ||
        ((p.path === 'credentials_proxy' || p.path === 'credential_quic') && machines.credentials),
    )
    .map((p) => ({
      path: p.path,
      from: p.from,
      to: p.to(scope),
      verdict: p.verdict,
      rule: p.rule(scope),
    }))
