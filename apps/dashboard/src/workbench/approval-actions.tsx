import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'

import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, idempotency, unwrap, type Approval, type Deployment, type Me } from '@/lib/api'
import { canDecide } from '@/lib/approval'
import { editItems, seed } from '@/lib/cache'
import { plural } from '@/lib/format'
import { approvalDecided } from '@/lib/invalidate'
import { done, useApiMutation } from '@/lib/mutation'
import { approvalQuery, approvalsQuery, meQuery, seedDeployment } from '@/lib/queries'

export type Decision = { decision: 'approve' } | { decision: 'reject'; reason?: string }

type Decidable = Pick<
  Approval,
  'id' | 'project_id' | 'source' | 'status' | 'requester' | 'requester_decides'
>

export const rejection = (reason: string): Decision => {
  const why = reason.trim()

  return why
    ? {
        decision: 'reject',
        reason: why,
      }
    : {
        decision: 'reject',
      }
}

export const deciderOf = (me: Me | undefined, approval: Decidable) => ({
  loaded: me !== undefined,
  human: me?.human ?? false,
  can: approval.status === 'waiting' && canDecide(me, approval),
  blocked:
    me?.actor.type === 'user' && me.actor.id === approval.requester && !approval.requester_decides,
})

export const useDecider = (approval: Decidable) => deciderOf(useQuery(meQuery).data, approval)

export function useDecision(
  id: string,
  onApplied?: (deployments: Deployment[], decision: Decision) => void,
) {
  return useApiMutation({
    mutationFn: async (body: Decision) =>
      done(
        await unwrap(
          api.v1
            .approvals({
              approval: id,
            })
            .decision.post(body, idempotency()),
        ),
      ),
    optimistic: () => [
      editItems(approvalsQuery('waiting'), (items) => items.filter((a) => a.id !== id)),
    ],
    seed: ({ deployments, ...approval }) => [
      seed(approvalQuery(id), {
        ...approval,
        deployments: deployments.map((d) => d.id),
      }),
      ...deployments.flatMap(seedDeployment),
    ],
    invalidate: [...approvalDecided, 'tasks'],
    success: (result, body) =>
      body.decision === 'approve'
        ? {
            title: 'Approved',
            description: result.deployments.length
              ? `Started ${plural(result.deployments.length, 'deployment')}.`
              : undefined,
          }
        : 'Rejected',
    onSuccess: (result, body) => {
      if (!result.waiting) {
        onApplied?.(result.body.deployments, body)
      }
    },
    failure: (body) => (body.decision === 'approve' ? 'approve this change' : 'reject this change'),
  })
}

export function RejectDialog({
  pending,
  disabled,
  onReject,
}: {
  pending: boolean
  disabled: boolean
  onReject: (decision: Decision) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="outline" size="sm" disabled={disabled}>
          <X /> Reject
        </Button>
      }
      title="Reject this change?"
      description="Stationly applies none of these changes. Whoever asked sees your reason."
      submitLabel="Reject change"
      submitVariant="destructive"
      pending={pending}
      onSubmit={() => {
        onReject(rejection(reason))
        setOpen(false)
      }}
    >
      <Field id="reject-reason" label="Reason (optional)">
        <Textarea
          id="reject-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
        />
      </Field>
    </FormDialog>
  )
}

export function ApproveButton({
  label,
  pending,
  disabled,
  onApprove,
}: {
  label: string
  pending: boolean
  disabled: boolean
  onApprove: () => void
}) {
  return (
    <Button size="sm" disabled={disabled} onClick={onApprove}>
      {pending ? <Loader2 className="animate-spin" /> : <Check />}
      {label}
    </Button>
  )
}
