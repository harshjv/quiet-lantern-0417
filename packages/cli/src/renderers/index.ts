import { renderPlan } from './manifest.ts'
import {
  connectionsText,
  dnsText,
  explanationText,
  liveConnectionsText,
  networkText,
} from './network.ts'
import { renderDoctor } from './platform.ts'

export type Render = (data: unknown) => string

const registered = {
  'network-map': networkText,
  connections: connectionsText,
  'live-connections': liveConnectionsText,
  explanation: explanationText,
  'dns-log': dnsText,
  doctor: renderDoctor,
  'plan-diff': renderPlan,
} satisfies Record<string, (data: never) => string>

export const rendererNames = Object.keys(registered)

export const renderer = (name: string) => (registered as Record<string, Render | undefined>)[name]
