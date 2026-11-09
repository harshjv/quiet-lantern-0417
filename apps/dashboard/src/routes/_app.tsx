import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { sessionQuery } from '@/lib/auth'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.query(sessionQuery)
    if (!session) throw redirect({ to: '/login', search: location.href === '/' ? {} : { next: location.href } })
    return { session }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  )
})
