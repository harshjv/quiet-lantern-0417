import { ExternalLink, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Approval } from '@/lib/api'

import { ApproveButton, rejection, useDecider, useDecision } from './approval-actions'

export type ShipApproval = Approval

export type ShipState = 'pushing' | 'open' | 'failed' | 'merged' | 'rejected' | 'superseded'

export const shipState = (approval: ShipApproval): ShipState => {
  if (approval.status === 'waiting') {
    return approval.ship?.phase ?? 'open'
  }

  return approval.status === 'approved' ? 'merged' : approval.status
}

export const shipProblem = (approval: ShipApproval) =>
  approval.status === 'rejected' ? approval.reason : (approval.ship?.reason ?? null)

export const shipStatusText: Record<ShipState, string> = {
  pushing: 'Pushing the branch and opening the pull request',
  open: 'Waiting for an admin to approve',
  rejected: 'Not shipped',
  merged: 'Merged; production is deploying',
  failed: 'Ship it did not finish',
  superseded: 'Replaced; ship again to ask anew',
}

export function PullRequestLink({ approval }: { approval: ShipApproval }) {
  const pull = approval.ship?.pull_request

  return pull ? (
    <Button asChild size="sm" variant="outline">
      <a href={pull.url} target="_blank" rel="noreferrer">
        <ExternalLink /> #{pull.number}
      </a>
    </Button>
  ) : null
}

function HeadSha({ approval }: { approval: ShipApproval }) {
  return approval.ship?.head_sha ? (
    <span className="font-mono text-xs text-muted-foreground">
      at {approval.ship.head_sha.slice(0, 7)}
    </span>
  ) : null
}

export function ShipDecision({ approval }: { approval: ShipApproval }) {
  const decider = useDecider(approval)
  const decide = useDecision(approval.id)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const open = shipState(approval) === 'open'

  if (!decider.can || !open) {
    return (
      <span className="flex items-center gap-2">
        <PullRequestLink approval={approval} />
        <HeadSha approval={approval} />
        {open && <span className="text-sm text-muted-foreground">Waiting for an admin</span>}
      </span>
    )
  }

  if (rejecting) {
    return (
      <span className="flex items-center gap-2">
        <Input
          className="w-64"
          autoFocus
          value={reason}
          placeholder="Why not, for the task's owner"
          aria-label="Reason"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setRejecting(false)
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate(rejection(reason))}
        >
          Send
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
          Cancel
        </Button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <PullRequestLink approval={approval} />
      <HeadSha approval={approval} />
      <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
        <X /> Reject
      </Button>
      {decider.blocked ? (
        <span className="text-sm text-muted-foreground">Another admin approves</span>
      ) : (
        <ApproveButton
          label="Approve and merge"
          pending={decide.isPending && decide.variables?.decision === 'approve'}
          disabled={decide.isPending}
          onApprove={() =>
            decide.mutate({
              decision: 'approve',
            })
          }
        />
      )}
    </span>
  )
}
