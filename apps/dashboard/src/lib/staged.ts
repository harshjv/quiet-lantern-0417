import type { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

export const stagedTitle = 'Waiting for your review'

export const stagedText = (act?: string) =>
  act ? `${act}. Nothing changes until you accept it.` : 'Nothing changes until you accept it.'

export const toastStaged = (
  navigate: ReturnType<typeof useNavigate>,
  change: string,
  act?: string,
) =>
  toast.message(stagedTitle, {
    description: stagedText(act),
    action: {
      label: 'Review',
      onClick: () =>
        void navigate({
          to: '/staged/$change',
          params: {
            change,
          },
        }),
    },
  })
