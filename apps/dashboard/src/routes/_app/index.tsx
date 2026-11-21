import { createFileRoute } from '@tanstack/react-router'

import { AllProjects } from '@/workbench/ship-live'

export const Route = createFileRoute('/_app/')({
  component: AllProjects,
})
