import { Minus, Pencil, Plus } from 'lucide-react'

import type { Change } from '@/lib/api'
import { json } from '@/lib/format'
import { sentence } from '@/lib/labels'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const opStyle = {
  add: {
    icon: Plus,
    label: 'Add',
    tone: toneText.success,
    bar: 'border-l-emerald-500',
  },
  update: {
    icon: Pencil,
    label: 'Change',
    tone: toneText.warning,
    bar: 'border-l-amber-500',
  },
  remove: {
    icon: Minus,
    label: 'Remove',
    tone: toneText.danger,
    bar: 'border-l-red-500',
  },
} as const

function Value({ value, tone }: { value: unknown; tone: 'old' | 'new' }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground italic">none</span>
  const text = json(value)
  return (
    <pre
      className={cn(
        'max-h-60 overflow-auto rounded px-2 py-1 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap',
        tone === 'old'
          ? 'bg-red-50 text-red-950 line-through decoration-red-400/60 dark:bg-red-950/40 dark:text-red-100'
          : 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100',
      )}
    >
      {text}
    </pre>
  )
}

function Fields({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return <Value value={value} tone="new" />
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded bg-emerald-50 px-2 py-1.5 font-mono text-[0.75rem] leading-5 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-emerald-800/80 dark:text-emerald-300/80">{k}</dt>
          <dd className="min-w-0 break-all whitespace-pre-wrap">
            {typeof v === 'string' ? v : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ChangeDiff({
  changes,
  refs,
}: {
  changes: Change[]
  refs?: Record<string, string> | null
}) {
  return (
    <ol className="divide-y overflow-hidden rounded-lg border" aria-label="Changes">
      {changes.map((change, i) => {
        const style = opStyle[change.op]
        const Icon = style.icon
        const name = change.id ?? change.ref ?? ''
        const assigned = change.ref ? refs?.[change.ref] : undefined
        return (
          <li
            key={i}
            className={cn('space-y-2 border-l-2 bg-card px-4 py-3', style.bar)}
            data-op={change.op}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className={cn('inline-flex items-center gap-1 font-medium', style.tone)}>
                <Icon className="size-3.5" aria-hidden />
                {style.label}
              </span>
              <span className="font-medium">{sentence(change.entity)}</span>
              <span className="font-mono text-xs text-muted-foreground">{name}</span>
              {assigned && (
                <span className="font-mono text-xs text-muted-foreground">→ {assigned}</span>
              )}
              {change.parent && (
                <span className="font-mono text-xs text-muted-foreground">in {change.parent}</span>
              )}
              {change.path && (
                <span className="rounded bg-muted px-1.5 font-mono text-xs">{change.path}</span>
              )}
            </div>
            {change.op === 'update' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Before</p>
                  <Value value={change.before} tone="old" />
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">After</p>
                  <Value value={change.after} tone="new" />
                </div>
              </div>
            )}
            {change.op === 'add' && change.after != null && <Fields value={change.after} />}
            {change.op === 'remove' && <Value value={change.before} tone="old" />}
          </li>
        )
      })}
    </ol>
  )
}
