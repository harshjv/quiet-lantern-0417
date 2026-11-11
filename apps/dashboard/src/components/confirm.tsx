import { Loader2, Trash2 } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'

import { FormError } from '@/components/form-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { failureText } from '@/lib/api'

export function Confirm({
  title,
  description,
  action = 'Remove',
  cancel = 'Cancel',
  destructive = true,
  onConfirm,
  renderError = (failure) => <FormError>{failureText(failure)}</FormError>,
  trigger,
  open: controlled,
  onOpenChange,
}: {
  title: ReactNode
  description: ReactNode
  action?: string
  cancel?: string
  destructive?: boolean
  onConfirm: () => Promise<unknown>
  renderError?: (failure: unknown) => ReactNode
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    if (!next) {
      setFailure(null)
    }

    setOwn(next)
    onOpenChange?.(next)
  }
  const confirm = async () => {
    setFailure(null)
    setPending(true)

    try {
      await onConfirm()
      setOpen(false)
    } catch (error) {
      setFailure(error)
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure !== null && renderError(failure)}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {pending && <Loader2 className="animate-spin" />}
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function RemoveButton({
  label,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
      <Trash2 />
    </Button>
  )
}
