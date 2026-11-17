import { PlaceLink } from '@/components/place-link'
import type { Approval, Deployment } from '@/lib/api'
import { entityIcon } from '@/lib/icons'
import { actorText, deploymentTrigger, isAgent } from '@/lib/labels'
import { places } from '@/lib/nav'

type Who = Pick<Approval['requested_by'], 'type' | 'client'>

export function Actor({ actor }: { actor: Who }) {
  if (!isAgent(actor)) {
    return actorText(actor)
  }

  return (
    <PlaceLink
      to={places.page('connect')}
      className="relative z-10 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
    >
      <entityIcon.agent className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {actorText(actor)}
    </PlaceLink>
  )
}

export function AgentsLink() {
  return (
    <PlaceLink
      to={places.page('connect')}
      className="underline underline-offset-4 hover:text-foreground"
    >
      agents
    </PlaceLink>
  )
}

export function Trigger({ trigger }: { trigger: Deployment['trigger'] }) {
  const label = deploymentTrigger[trigger.type]

  if (!trigger.actor || trigger.actor.type === 'user') {
    return label
  }

  if (trigger.type === 'agent') {
    return <Actor actor={trigger.actor} />
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      {label} by <Actor actor={trigger.actor} />
    </span>
  )
}
