import { toast } from 'sonner'

import type { Approval } from './api'
import { go, places } from './nav'

export const waitingTitle = 'Waiting for approval'

export const waitingText = (act?: string) =>
  act
    ? `${act}. Nothing changes until an admin approves it.`
    : 'Nothing changes until an admin approves it.'

export const toastWaiting = (approval: string, act?: string) =>
  toast.message(waitingTitle, {
    description: waitingText(act),
    action: {
      label: 'Review',
      onClick: () => go(places.approval(approval)),
    },
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
