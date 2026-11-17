import { createFileRoute } from '@tanstack/react-router'

import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/connect')({
  head: () => pageHead('connect'),
  component: () => <OutsideScreen page="connect" />,
})
