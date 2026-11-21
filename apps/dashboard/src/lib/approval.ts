import { toast } from 'sonner'

import type { Approval } from './api'

export const waitingTitle = 'Waiting for approval'

const waitingText = (act?: string) => (act ? `${act}. Waits for an admin.` : 'Waits for an admin.')

export const toastWaiting = (act?: string) =>
  toast.message(waitingTitle, {
    description: waitingText(act),
  })

type Scope = { project_id: string; target: string; level: string }

type Caller = { human: boolean; scopes: readonly Scope[] }

const covers = (granted: string, wanted: string) => granted === '*' || granted === wanted

const adminOn = (scopes: readonly Scope[], project: string, target: string) =>
  scopes.some(
    (scope) =>
      scope.level === 'admin' && covers(scope.project_id, project) && covers(scope.target, target),
  )

export const canDecide = (
  caller: Caller | undefined,
  approval: Pick<Approval, 'project_id' | 'source'>,
) =>
  Boolean(caller?.human) &&
  (approval.source === 'task' || !approval.project_id
    ? adminOn(caller!.scopes, '*', '*')
    : adminOn(caller!.scopes, approval.project_id, 'production'))
