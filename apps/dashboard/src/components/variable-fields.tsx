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
  sealedNote,
  variableKeyPattern,
  variableKeyTitle,
  variableKinds,
  type VariableKind,
} from '@/lib/variables'

export function VariableKeyInput({
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
      pattern={variableKeyPattern}
      title={variableKeyTitle}
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
  value: VariableKind
  onValueChange: (kind: VariableKind) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as VariableKind)}>
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
  kind: VariableKind
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
      type={kind === 'sealed' ? 'password' : 'text'}
      autoComplete={kind === 'sealed' ? 'new-password' : 'off'}
      onChange={(e) => onValueChange(e.target.value)}
      placeholder={kind === 'reference' ? referencePlaceholder : placeholder}
    />
  )
}

export function VariableNotes({ sealed, build }: { sealed: boolean; build: boolean }) {
  return (
    <>
      {sealed && <Hint>{sealedNote}</Hint>}
      {build && <Hint>{buildNote}</Hint>}
    </>
  )
}
