import { createFileRoute } from '@tanstack/react-router'

import { approvalHeading, headOf } from '@/lib/heads'
import { ApprovalPage } from '@/workbench/approval-live'

export const Route = createFileRoute('/_app/_outside/approvals/$approval')({
  loader: ({ context, params }) => approvalHeading(context.queryClient, params.approval),
  head: ({ loaderData }) => headOf(loaderData, 'Inbox'),
  component: function Approval() {
    return <ApprovalPage approvalId={Route.useParams().approval} />
  },
})
