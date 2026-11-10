import { Loader2 } from 'lucide-react'
import type { ComponentProps, FormEvent, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function FormError({ id, children }: { id?: string; children: ReactNode }) {
  if (!children) return null
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {children}
    </p>
  )
}

type FormProps = {
  title: ReactNode
  description: ReactNode
  notice?: ReactNode
  also?: ReactNode
  error?: ReactNode
  submitLabel: ReactNode
  pending: boolean
  submitDisabled?: boolean
  submitVariant?: ComponentProps<typeof Button>['variant']
  onSubmit: () => void
  onCancel: () => void
  children?: ReactNode
}

export function DialogForm({
  title,
  description,
  notice,
  also,
  error,
  submitLabel,
  pending,
  submitDisabled,
  submitVariant,
  onSubmit,
  onCancel,
  children,
}: FormProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {notice}
      {typeof error === 'string' ? <FormError>{error}</FormError> : error}
      {children}
      {also && <div className="border-t pt-3 [&>*]:justify-start">{also}</div>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant={submitVariant} disabled={pending || submitDisabled}>
          {pending && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

const sizes = {
  md: 'sm:max-w-md',
  lg: 'sm:max-w-xl',
} as const

export const dialogScroll = 'max-h-[calc(100dvh-2rem)] overflow-y-auto'

export function FormDialog({
  open,
  onOpenChange,
  trigger,
  size,
  hideWhilePending,
  ...form
}: Omit<FormProps, 'onCancel'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: ReactNode
  size?: keyof typeof sizes
  hideWhilePending?: boolean
}) {
  return (
    <Dialog open={open && !(hideWhilePending && form.pending)} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        className={cn(dialogScroll, size && sizes[size])}
        onOpenAutoFocus={(event) => {
          const field = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            'form input:not([type=hidden]), form textarea, form [role=combobox]',
          )
          if (!field) return
          event.preventDefault()
          field.focus()
        }}
      >
        <DialogForm {...form} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
