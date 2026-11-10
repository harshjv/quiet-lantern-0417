import type { ReactNode } from 'react'
import { FieldSet } from '@/components/field'
import { cn } from '@/lib/utils'

export function ChoiceCards<T extends string>({
  name,
  legend,
  value,
  onChange,
  options,
  className
}: {
  name: string
  legend: ReactNode
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; title: ReactNode; hint: ReactNode }[]
  className?: string
}) {
  return (
    <FieldSet legend={legend}>
      <div className={cn('grid grid-cols-2 gap-2', className)}>
        {options.map(option => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="mt-0.5 accent-foreground" />
            <span>
              <span className="block font-medium">{option.title}</span>
              <span className="block text-xs text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </FieldSet>
  )
}
