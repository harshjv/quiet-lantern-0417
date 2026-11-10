import { toast } from 'sonner'

import { failureText } from './api'

export const failedTitle = (action: string) => `Couldn’t ${action}`

export const toastFailure = (action: string, failure: unknown) =>
  toast.error(failedTitle(action), {
    description: failureText(failure),
  })
