import { createFileRoute } from '@tanstack/react-router'

import { z } from '@/lib/zod'
import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/servers')({
  validateSearch: z.object({
    server: z.string().optional().catch(undefined),
  }),
  head: () => pageHead('servers'),
  component: () => <OutsideScreen page="servers" />,
})
