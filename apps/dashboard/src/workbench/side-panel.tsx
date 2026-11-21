import { Link, type LinkOptions } from '@tanstack/react-router'
import { X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

export function SidePanel({
  title,
  icon: Icon,
  status,
  subtitle,
  action,
  closeTo,
  children,
}: {
  title: string
  icon: LucideIcon
  status?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  closeTo: LinkOptions
  children: ReactNode
}) {
  return (
    <aside
      className="flex min-w-0 flex-col gap-4 border bg-card p-4 xl:w-lg xl:shrink-0"
      aria-label={title}
      data-testid="side-panel"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 truncate font-display text-lg">{title}</h2>
          {status}
          <Button asChild size="icon" variant="ghost" className="ml-auto size-8 shrink-0">
            <Link {...closeTo} aria-label="Close">
              <X />
            </Link>
          </Button>
        </div>
        {(subtitle || action) && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 truncate">{subtitle}</span>
            {action}
          </div>
        )}
      </div>
      {children}
    </aside>
  )
}
