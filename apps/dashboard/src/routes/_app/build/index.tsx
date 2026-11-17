import { createFileRoute } from '@tanstack/react-router'

import { LiveBuild } from '@/workbench/build-live'

export const Route = createFileRoute('/_app/build/')({
  component: () => <LiveBuild project={Route.useSearch().project ?? null} />,
})
