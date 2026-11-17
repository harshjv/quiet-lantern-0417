import { createFileRoute } from '@tanstack/react-router'

import { z } from '@/lib/zod'
import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/account')({
  validateSearch: z.object({
    github: z.literal('failed').optional().catch(undefined),
  }),
  head: () => pageHead('account'),
  component: () => <OutsideScreen page="account" />,
})
