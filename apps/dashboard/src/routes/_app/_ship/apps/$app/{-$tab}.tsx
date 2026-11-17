import { createFileRoute } from '@tanstack/react-router'

import { appHeading, headOf } from '@/lib/heads'
import { AppPage } from '@/workbench/ship-app'

export const Route = createFileRoute('/_app/_ship/apps/$app/{-$tab}')({
  loader: ({ context, params }) => appHeading(context.queryClient, params.app),
  head: ({ loaderData }) => headOf(loaderData, 'Ship'),
  component: function App() {
    const { app, tab } = Route.useParams()

    return <AppPage appId={app} tab={tab ?? null} />
  },
})
