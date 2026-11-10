import { CircleAlert, Inbox } from 'lucide-react'
import type { ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiFailure } from '@/lib/api'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  meta,
  actions,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {meta && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {meta}
          </div>
        )}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function Subsection({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function ErrorState({
  error,
  title = 'This could not be loaded',
}: {
  error: unknown
  title?: string
}) {
  const failure = error instanceof ApiFailure ? error : null
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{failure ? `${title}: ${failure.code}` : title}</AlertTitle>
      <AlertDescription className="text-foreground">
        <p>{error instanceof Error ? error.message : String(error)}</p>
        {failure && <p className="text-muted-foreground">{failure.fix}</p>}
        {failure?.requestId && (
          <p className="font-mono text-xs text-muted-foreground">request {failure.requestId}</p>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <Inbox className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Rows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from(
        {
          length: count,
        },
        (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ),
      )}
    </div>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[0.8125rem]', className)}>{children}</span>
}

export function KeyValue({
  items,
  framed,
  children,
}: {
  items: [string, ReactNode][]
  framed?: boolean
  children?: ReactNode
}) {
  const list = (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  )
  if (!framed) return list
  return (
    <div className="rounded-lg border bg-card p-4">
      {list}
      {children}
    </div>
  )
}
