import type { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

export const toastStaged = (navigate: ReturnType<typeof useNavigate>, title: string, change: string) =>
  toast.message(title, {
    description: 'This environment is protected; it applies when a human accepts the change.',
    action: { label: 'Review', onClick: () => void navigate({ to: '/staged/$change', params: { change } }) }
  })
