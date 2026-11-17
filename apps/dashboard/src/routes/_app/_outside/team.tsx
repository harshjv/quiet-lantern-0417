import { createFileRoute } from '@tanstack/react-router'

import { OutsideScreen, pageHead } from '@/workbench/outside'

export const Route = createFileRoute('/_app/_outside/team')({
  head: () => pageHead('team'),
  component: () => <OutsideScreen page="team" />,
})
