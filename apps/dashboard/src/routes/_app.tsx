import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { sessionQuery } from '@/lib/auth'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.query({
      ...sessionQuery,
      staleTime: ({ state }) =>
        state.data && Date.parse(state.data.expiresAt) > Date.now() ? 'static' : 0,
    })

    if (!session) {
      throw redirect({
        to: '/login',
        search:
          location.href === '/'
            ? {}
            : {
                next: location.href,
              },
      })
    }

    return {
      session,
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
})
