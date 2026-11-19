export const explanationVerdicts = ['reachable', 'blocked', 'broken', 'unknown'] as const

export type ExplanationVerdict = (typeof explanationVerdicts)[number]

export const hopNames = [
  'source',
  'applied',
  'dns',
  'allowlist',
  'firewall',
  'switch',
  'target',
  'listening',
  'port',
  'probe_required',
  'domain',
  'tunnel',
  'route',
] as const

export type HopName = (typeof hopNames)[number]

export const hopStatuses = ['pass', 'fail', 'warn', 'skipped', 'unknown'] as const

export type HopStatus = (typeof hopStatuses)[number]
