import { createFileRoute } from '@tanstack/react-router'

import { headOf, machineHeading } from '@/lib/heads'
import { MachinePage } from '@/workbench/machine-page'

export const Route = createFileRoute('/_app/_ship/machines/$machine/{-$tab}')({
  loader: ({ context, params }) => machineHeading(context.queryClient, params.machine),
  head: ({ loaderData }) => headOf(loaderData, 'Ship'),
  component: function Machine() {
    const { machine, tab } = Route.useParams()

    return <MachinePage machineId={machine} tab={tab ?? null} />
  },
})
