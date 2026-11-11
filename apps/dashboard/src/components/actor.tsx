import { Link } from '@tanstack/react-router'

import type { Deployment, StagedChange } from '@/lib/api'
import { entityIcon } from '@/lib/icons'
import { actorText, deploymentTrigger, isAgent } from '@/lib/labels'

type Who = Pick<StagedChange['actor'], 'type' | 'client'>

export function Actor({ actor }: { actor: Who }) {
  if (!isAgent(actor)) {
    return actorText(actor)
  }

  return (
    <Link
      to="/agents"
      className="relative z-10 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
    >
      <entityIcon.agent className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {actorText(actor)}
    </Link>
  )
}

export function AgentsLink() {
  return (
    <Link to="/agents" className="underline underline-offset-4 hover:text-foreground">
      agents
    </Link>
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
