import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { ErrorState, Rows } from '@/components/page'

export function QueryState<T>({
  query,
  rows,
  errorTitle,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>
  rows?: number
  errorTitle?: string
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (query.isPending) return <Rows count={rows} />
  if (query.isError) return <ErrorState error={query.error} title={errorTitle} />
  if (isEmpty?.(query.data)) return empty
  return children(query.data)
}

export const noItems = (data: { items: unknown[] }) => data.items.length === 0
