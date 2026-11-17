import { createFileRoute } from '@tanstack/react-router'

import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/servers')({
  head: () => pageHead('servers'),
  component: () => <OutsideScreen page="servers" />,
})
