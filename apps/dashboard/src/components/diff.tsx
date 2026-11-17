import { ArrowRight, Minus, Pencil, Plus, Rocket } from 'lucide-react'

import type { Change } from '@/lib/api'
import { changeFields, describeChange, type Field, type Names } from '@/lib/changes'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const opStyle = {
  add: {
    icon: Plus,
    tone: toneText.success,
    bar: 'border-l-emerald-500',
  },
  update: {
    icon: Pencil,
    tone: toneText.warning,
    bar: 'border-l-amber-500',
  },
  remove: {
    icon: Minus,
    tone: toneText.danger,
    bar: 'border-l-red-500',
  },
} as const

function FieldValue({ field }: { field: Field }) {
  if ('value' in field) {
    return <span className="break-words">{field.value}</span>
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className="text-muted-foreground line-through decoration-red-400/70">
        {field.before}
      </span>
      <ArrowRight className="size-3.5 text-muted-foreground" aria-label="becomes" />
      <span>{field.after}</span>
    </span>
  )
}

export function ChangeDiff({ changes, names }: { changes: Change[]; names: Names }) {
  return (
    <ol className="divide-y overflow-hidden rounded-lg border" aria-label="Changes">
      {changes.map((change, i) => {
        const style = opStyle[change.op]
        const Icon = change.entity === 'deployment' ? Rocket : style.icon
        const { verb, noun, name, parent } = describeChange(change, changes, names)
        const fields = changeFields(change, names)

        return (
          <li
            key={change.ref ?? change.id ?? i}
            className={cn('flex flex-col gap-2 border-l-2 bg-card px-4 py-3', style.bar)}
            data-op={change.op}
          >
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
              <span
                className={cn('inline-flex items-center gap-1 self-center font-medium', style.tone)}
              >
                <Icon className="size-3.5" aria-hidden />
                {verb}
              </span>
              {noun && <span className="text-muted-foreground">{noun}</span>}
              {name && <span className="font-medium">{name}</span>}
              {parent && (
                <span className="text-muted-foreground">
                  to <span className="text-foreground">{parent}</span>
                </span>
              )}
            </p>
            {fields.length > 0 && (
              <dl className="grid grid-cols-[11rem_1fr] gap-x-6 gap-y-1 pl-5 text-sm">
                {fields.map((field) => (
                  <div key={field.key} className="contents">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0">
                      <FieldValue field={field} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        )
      })}
    </ol>
  )
}
