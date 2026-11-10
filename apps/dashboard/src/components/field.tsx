import type { ReactNode } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export const hintId = (id: string) => `${id}-hint`

export function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {children}
    </p>
  )
}

export function Field({
  id,
  label,
  hint,
  className,
  labelClassName,
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  className?: string
  labelClassName?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={labelClassName}>
        {label}
      </Label>
      {children}
      {hint && <Hint id={hintId(id)}>{hint}</Hint>}
    </div>
  )
}

export function Suffixed({ suffix, children }: { suffix: ReactNode; children: ReactNode }) {
  return (
    <div className="relative [&_input]:pr-12">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
        {suffix}
      </span>
    </div>
  )
}

export function FieldSet({
  legend,
  hint,
  className,
  children,
}: {
  legend: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset className={cn('flex flex-col gap-2', className)}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {hint && <Hint>{hint}</Hint>}
      {children}
    </fieldset>
  )
}

export function CheckboxField({
  id,
  checked,
  onCheckedChange,
  label,
  hint,
  className,
  labelClassName,
}: {
  id: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  className?: string
  labelClassName?: string
}) {
  const box = (
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn(hint && 'mt-0.5')}
      aria-describedby={hint ? hintId(id) : undefined}
    />
  )
  const text = (
    <Label htmlFor={id} className={cn('font-normal', labelClassName)}>
      {label}
    </Label>
  )
  if (!hint)
    return (
      <div className={cn('flex items-center gap-2', className)}>
        {box}
        {text}
      </div>
    )
  return (
    <div className={cn('flex items-start gap-2', className)}>
      {box}
      <div className="space-y-0.5">
        {text}
        <Hint id={hintId(id)}>{hint}</Hint>
      </div>
    </div>
  )
}
