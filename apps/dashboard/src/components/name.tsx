import type { ReactNode } from 'react'

import { entityIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

type NameKind = keyof typeof entityIcon

const freeText: NameKind[] = ['task']

export function Name({
  kind,
  children,
  chip = true,
  className,
}: {
  kind: NameKind
  children: ReactNode
  chip?: boolean
  className?: string
}) {
  const Icon = entityIcon[kind]
  const quoted = freeText.includes(kind)

  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle font-medium',
        chip && 'border bg-muted px-2 py-0.5',
        className,
      )}
    >
      {chip && <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="truncate">{quoted ? <>“{children}”</> : children}</span>
    </span>
  )
}
