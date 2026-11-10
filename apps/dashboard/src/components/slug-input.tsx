import type { ComponentProps } from 'react'

import { Input } from '@/components/ui/input'
import { slugPattern, slugTitle } from '@/lib/format'
import { cn } from '@/lib/utils'

export function SlugInput({
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
      {...props}
      value={value}
      onChange={(e) => onValueChange(e.target.value.toLowerCase())}
      pattern={slugPattern}
      title={slugTitle}
      className={cn('font-mono', className)}
    />
  )
}
