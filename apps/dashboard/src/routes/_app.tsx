import { createFileRoute, redirect } from '@tanstack/react-router'

import { sessionQuery } from '@/lib/auth'
import { App } from '@/workbench/app'
import { projectSearch } from '@/workbench/where'

export const Route = createFileRoute('/_app')({
  validateSearch: projectSearch,
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.query({
      ...sessionQuery,
      staleTime: ({ state }) =>
        state.data && Date.parse(state.data.expiresAt) > Date.now() ? 'static' : 0,
    })

    if (!session) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href,
        },
      })
    }
  },
  component: App,
})
