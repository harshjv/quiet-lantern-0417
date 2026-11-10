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
  'exposure',
  'public_address',
  'web_ports',
  'certificate',
  'route',
] as const

export type HopName = (typeof hopNames)[number]

export const hopStatuses = ['pass', 'fail', 'warn', 'skipped', 'unknown'] as const

export type HopStatus = (typeof hopStatuses)[number]

export const networkRemedyValues = [
  'DEPLOY_TARGET',
  'START_TARGET',
  'BIND_ALL_INTERFACES',
  'USE_DECLARED_PORT',
  'DECLARE_PORT',
  'USE_INTERNAL_NAME',
  'ATTACH_SHARED',
  'EXPOSE_TCP',
  'ADD_DOMAIN',
  'WAIT_FOR_APPLY',
  'CHECK_DNS_RECORD',
  'SET_PUBLIC_ADDRESS',
  'RUN_PROBE',
  'ALLOW_DOMAIN',
  'JOIN_ENVIRONMENT',
] as const

export type NetworkRemedy = (typeof networkRemedyValues)[number]
