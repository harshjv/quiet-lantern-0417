import type { QueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { Empty } from '@/components/page'
import { Toaster } from '@/components/ui/sonner'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <Toaster position="bottom-right" closeButton toastOptions={{ classNames: { toast: 'cn-toast', description: '!text-foreground/80' } }} />
    </>
  ),
  notFoundComponent: () => (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="sr-only">Not found</h1>
      <Empty title="Nothing lives at this address">
        <Link to="/" className="underline underline-offset-4">
          Back to projects
        </Link>
      </Empty>
    </main>
  )
})
