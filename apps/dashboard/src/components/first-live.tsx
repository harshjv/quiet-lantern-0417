import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, CircleCheck } from 'lucide-react'

import { Code } from '@/components/code'
import { AppStatus } from '@/components/status'
import { Button } from '@/components/ui/button'
import type { App } from '@/lib/api'
import { liveText } from '@/lib/completion'
import { domainsQuery } from '@/lib/queries'
import { tonePanel } from '@/lib/tone'
import { cn } from '@/lib/utils'

export function FirstLive({ app }: { app: App }) {
  const domains = useQuery(domainsQuery(app.id))
  const domain = domains.data?.items.find((d) => d.status === 'active')
  const address = domain?.hostname ?? `${app.name}.internal`

  return (
    <div
      data-moment="live"
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm',
        tonePanel.success,
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        {liveText(app.name)}
      </span>
      <AppStatus status={app.status} />
      <span data-moment="address" className="flex items-center gap-2 sm:ml-auto">
        <Code copy={address}>{address}</Code>
        {domain && (
          <Button asChild size="sm" variant="outline">
            <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer noopener">
              Open <ArrowUpRight />
            </a>
          </Button>
        )}
      </span>
    </div>
  )
}
