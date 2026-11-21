import { createFileRoute } from '@tanstack/react-router'

import { z } from '@/lib/zod'
import { inboxGroups } from '@/workbench/inbox'
import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/inbox')({
  validateSearch: z.object({
    project: z.string().optional().catch(undefined),
    view: z.enum(['waiting', 'history']).optional().catch(undefined),
    group: z.enum(inboxGroups).optional().catch(undefined),
    status: z.enum(['approved', 'rejected', 'superseded']).optional().catch(undefined),
  }),
  head: () => pageHead('inbox'),
  component: () => <OutsideScreen page="inbox" />,
})
