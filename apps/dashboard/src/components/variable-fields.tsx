import type { ComponentProps } from 'react'

import { Hint } from '@/components/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { variableKind } from '@/lib/labels'
import { cn } from '@/lib/utils'
import {
  buildNote,
  referencePlaceholder,
  secretNote,
  variableKinds,
  variableNamePattern,
  variableNameTitle,
  type EnvironmentVariableKind,
} from '@/lib/variables'

export function VariableNameInput({
  value,
  onValueChange,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'pattern' | 'title'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <Input
      required
      {...props}
      value={value}
      onChange={(e) => onValueChange(e.target.value.toUpperCase())}
      pattern={variableNamePattern}
      title={variableNameTitle}
      className={cn('font-mono', className)}
    />
  )
}

export function VariableKindSelect({
  id,
  label,
  value,
  onValueChange,
}: {
  id?: string
  label?: string
  value: EnvironmentVariableKind
  onValueChange: (kind: EnvironmentVariableKind) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as EnvironmentVariableKind)}>
      <SelectTrigger id={id} aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {variableKinds.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {variableKind[kind]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type ValueProps = {
  kind: EnvironmentVariableKind
  value: string
  onValueChange: (value: string) => void
  multiline?: boolean
  id?: string
  label?: string
  placeholder?: string
  className?: string
}

export function VariableValueInput({
  kind,
  value,
  onValueChange,
  multiline,
  id,
  label,
  placeholder,
  className,
}: ValueProps) {
  const shared = {
    id,
    'aria-label': label,
    required: true,
    value,
    className: cn('font-mono', className),
    spellCheck: false,
  }

  if (kind === 'literal' && multiline) {
    return (
      <Textarea
        {...shared}
        rows={3}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
      />
    )
  }

  return (
    <Input
      {...shared}
      type={kind === 'secret' ? 'password' : 'text'}
      autoComplete={kind === 'secret' ? 'new-password' : 'off'}
      onChange={(e) => onValueChange(e.target.value)}
      placeholder={kind === 'reference' ? referencePlaceholder : placeholder}
    />
  )
}

export function VariableNotes({ secret, build }: { secret: boolean; build: boolean }) {
  return (
    <>
      {secret && <Hint>{secretNote}</Hint>}
      {build && <Hint>{buildNote}</Hint>}
    </>
  )
}
