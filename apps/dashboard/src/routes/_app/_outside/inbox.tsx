import { createFileRoute } from '@tanstack/react-router'

import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/inbox')({
  head: () => pageHead('inbox'),
  component: () => <OutsideScreen page="inbox" />,
})
