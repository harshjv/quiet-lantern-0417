import { CircleAlert, Inbox, RotateCw, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { CopyButton } from '@/components/copy'
import { ErrorFix } from '@/components/fix'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiFailure } from '@/lib/api'
import type { FixContext } from '@/lib/fixes'
import { toneBorder, toneText } from '@/lib/tone'
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

function ErrorFooter({ failure }: { failure: ApiFailure }) {
  const details = [
    failure.code,
    ...(failure.requestId ? [`Request ${failure.requestId}`] : []),
  ].join(' · ')

  return (
    <div className="flex items-center gap-1 pt-1 font-mono text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{details}</span>
      <CopyButton
        value={`${details}\n${window.location.href}`}
        label="error details"
        className="size-5"
      />
    </div>
  )
}

export function ErrorState({
  error,
  title = 'Couldn’t load this page',
  action,
  onRetry,
  fixes,
}: {
  error: unknown
  title?: string
  action?: ReactNode
  onRetry?: () => void
  fixes?: FixContext
}) {
  const failure = error instanceof ApiFailure ? error : null

  return (
    <Alert className={toneBorder.danger}>
      <CircleAlert className={toneText.danger} />
      <AlertTitle className="font-medium">{title}</AlertTitle>
      <AlertDescription className="space-y-1.5 [&_p:not(:last-child)]:mb-0">
        <p className="text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </p>
        {failure && <p className="text-foreground">{failure.fix}</p>}
        {failure && fixes && <ErrorFix failure={failure} context={fixes} />}
        {(action || onRetry) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {action}
            {onRetry && (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                <RotateCw aria-hidden />
                Try again
              </Button>
            )}
          </div>
        )}
        {failure && <ErrorFooter failure={failure} />}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  also,
  className,
}: {
  icon?: LucideIcon
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  also?: ReactNode
  className?: string
}) {
  return (
    <Empty className={cn('rounded-lg border border-dashed px-6 py-10', className)}>
      <EmptyHeader className="max-w-md">
        <EmptyMedia variant="icon">
          <Icon className="text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {(action || also) && (
        <EmptyContent className="max-w-2xl gap-4">
          {action}
          {also}
        </EmptyContent>
      )}
    </Empty>
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
  const list = items.length > 0 && (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  )

  if (!framed) {
    return list
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      {list}
      {children && <div className={cn(items.length > 0 && 'mt-4 border-t pt-4')}>{children}</div>}
    </div>
  )
}
