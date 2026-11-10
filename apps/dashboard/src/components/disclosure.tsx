import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export function Disclosure({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/disclosure border-t pt-3">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/disclosure:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span className="shrink-0 font-medium">{title}</span>
        {summary && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 pl-6">{children}</CollapsibleContent>
    </Collapsible>
  )
}
