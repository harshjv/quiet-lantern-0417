import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Link, Outlet } from '@tanstack/react-router'
import { MapPinOff } from 'lucide-react'

import { EmptyState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { titled } from '@/lib/title'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => titled(),
  component: () => (
    <>
      <HeadContent />
      <Outlet />
      <Toaster
        position="bottom-right"
        closeButton
        toastOptions={{
          classNames: {
            toast: 'cn-toast',
            description: '!text-foreground/80',
          },
        }}
      />
    </>
  ),
  notFoundComponent: () => (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={MapPinOff}
        title="This page doesn’t exist"
        description="Check the address, or start again from your projects."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/projects">Go to projects</Link>
          </Button>
        }
      />
    </main>
  ),
})
