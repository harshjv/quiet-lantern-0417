import { human } from '../output.ts'

import { deploymentExit, deploymentText, runExit } from './deployments.ts'
import { connectionsText, dnsText, liveConnectionsText, networkText, probeText } from './network.ts'
import {
  eventPageText,
  eventRowText,
  logEventText,
  logPageText,
  metricsEventText,
} from './observability.ts'
import { doctorExit, renderDoctor, renderInventory } from './platform.ts'

export type Render = (data: unknown) => string

export type Renderer = {
  text: Render
  event?: (data: unknown, name: string) => string | null
  exit?: (data: unknown) => number
}

type Registered = {
  text: (data: never) => string
  event?: (data: never, name: string) => string | null
  exit?: (data: never) => number
}

const registered = {
  'network-map': {
    text: networkText,
  },
  connections: {
    text: connectionsText,
  },
  'live-connections': {
    text: liveConnectionsText,
  },
  probe: {
    text: probeText,
  },
  'dns-log': {
    text: dnsText,
  },
  doctor: {
    text: renderDoctor,
    exit: doctorExit,
  },
  inventory: {
    text: renderInventory,
  },
  deployment: {
    text: deploymentText,
    exit: deploymentExit,
  },
  run: {
    text: human,
    exit: runExit,
  },
  logs: {
    text: logPageText,
    event: logEventText,
  },
  metrics: {
    text: human,
    event: metricsEventText,
  },
  events: {
    text: eventPageText,
    event: eventRowText,
  },
} satisfies Record<string, Registered>

export const rendererNames = Object.keys(registered)

export const renderer = (name: string) => (registered as Record<string, Renderer | undefined>)[name]
