import type { Deployment, Event } from './api'
import { isAgent } from './labels.ts'

type Outcome = 'active' | 'failed'

export type Completion = { deployment: string; number: number; outcome: Outcome }

const outcomes = new Map<string, Outcome>([
  ['deployment.active', 'active'],
  ['deployment.failed', 'failed'],
])

export const completionOf = (event: Pick<Event, 'type' | 'subject' | 'payload'>) => {
  const outcome = outcomes.get(event.type)
  const number = event.payload.number
  if (!outcome || event.subject.entity !== 'deployment' || typeof number !== 'number') return null
  return {
    deployment: event.subject.id,
    number,
    outcome,
  } satisfies Completion
}

export const startedByAgent = (trigger: Deployment['trigger']) =>
  trigger.type === 'agent' || Boolean(trigger.actor && isAgent(trigger.actor))

export const completionText = ({ number, outcome }: Completion, service: string) => ({
  title: outcome === 'active' ? `${service} is live` : `${service} failed to deploy`,
  description: `Deployment #${number}`,
  action: outcome === 'active' ? 'Open' : 'See why',
})
