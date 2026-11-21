import { createFileRoute } from '@tanstack/react-router'

import { deploymentHeading, headOf } from '@/lib/heads'
import { z } from '@/lib/zod'
import { DeploymentPage } from '@/workbench/ship-deployment'

export const Route = createFileRoute('/_app/_outside/deployments/$deployment')({
  validateSearch: z.object({
    logs: z.enum(['runtime', 'build']).optional().catch(undefined),
  }),
  loader: ({ context, params }) => deploymentHeading(context.queryClient, params.deployment),
  head: ({ loaderData }) => headOf(loaderData, 'Deployment'),
  component: function Deployment() {
    return <DeploymentPage deploymentId={Route.useParams().deployment} />
  },
})
