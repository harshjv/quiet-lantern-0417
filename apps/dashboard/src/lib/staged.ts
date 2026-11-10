import type { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

export const toastStaged = (navigate: ReturnType<typeof useNavigate>, title: string, change: string, description = 'This environment is protected; it applies when a human accepts the change.') =>
  toast.message(title, {
    description,
    action: { label: 'Review', onClick: () => void navigate({ to: '/staged/$change', params: { change } }) }
  })
