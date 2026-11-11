import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { CatchBoundary, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { Suspense, useEffect, type ReactNode } from 'react'

import { ErrorState, Rows } from '@/components/page'

export function Failure({
  error,
  title,
  onRetry,
}: {
  error: unknown
  title?: string
  onRetry?: () => void
}) {
  const { reset } = useQueryErrorResetBoundary()

  useEffect(() => reset(), [reset])

  return <ErrorState error={error} title={title} onRetry={onRetry} />
}

export const failurePage = (title: string) =>
  function PageFailure({ error }: ErrorComponentProps) {
    const router = useRouter()

    return <Failure error={error} title={title} onRetry={() => void router.invalidate()} />
  }

export function Panel({
  title,
  rows,
  resetKey,
  children,
}: {
  title?: string
  rows?: number
  resetKey?: unknown
  children: ReactNode
}) {
  return (
    <CatchBoundary
      getResetKey={() => resetKey}
      errorComponent={({ error, reset }) => <Failure error={error} title={title} onRetry={reset} />}
    >
      <Suspense fallback={<Rows count={rows} />}>{children}</Suspense>
    </CatchBoundary>
  )
}
