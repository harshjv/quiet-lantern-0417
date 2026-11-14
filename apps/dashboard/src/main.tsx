import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Rows } from '@/components/page'
import { Failure } from '@/components/panel'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiFailure } from '@/lib/api'

import { routeTree } from './routeTree.gen'

import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !(error instanceof ApiFailure && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
})

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 1000,
  defaultPendingMinMs: 400,
  defaultPendingComponent: () => <Rows count={6} />,
  scrollRestoration: true,
  defaultErrorComponent: ({ error }) => (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Failure error={error} />
    </div>
  ),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }

  interface StaticDataRouteOption {
    fullBleed?: boolean
  }
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('missing #root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
