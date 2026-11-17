import { createFileRoute } from '@tanstack/react-router'

import { deploymentHeading, headOf } from '@/lib/heads'
import { DeploymentPage } from '@/workbench/ship-deployment'

export const Route = createFileRoute('/_app/_ship/deployments/$deployment')({
  loader: ({ context, params }) => deploymentHeading(context.queryClient, params.deployment),
  head: ({ loaderData }) => headOf(loaderData, 'Ship'),
  component: function Deployment() {
    return <DeploymentPage deploymentId={Route.useParams().deployment} />
  },
})
