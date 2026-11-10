import type { ReactNode } from 'react'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { terms, type TermKey } from '@/lib/labels'

export function Term({ name, children }: { name: TermKey; children?: ReactNode }) {
  const term = terms[name]
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {children ?? term.term}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 space-y-1 text-left font-normal" align="start">
        <p className="font-medium text-foreground">{term.term}</p>
        <p className="text-muted-foreground">{term.definition}</p>
      </HoverCardContent>
    </HoverCard>
  )
}
