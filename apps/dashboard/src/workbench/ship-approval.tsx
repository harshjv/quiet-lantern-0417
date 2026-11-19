import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Rocket, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Approval, Deployment } from '@/lib/api'
import { approvalQuery, deploymentQuery } from '@/lib/queries'
import { isInFlight } from '@/lib/status'

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
  merged: 'Merged',
  failed: 'Ship it did not finish',
  superseded: 'Replaced; ship again to ask anew',
}

export type ShipTone = 'info' | 'warning' | 'danger' | 'success'

const shipTone: Record<ShipState, ShipTone> = {
  pushing: 'info',
  open: 'warning',
  rejected: 'danger',
  merged: 'success',
  failed: 'danger',
  superseded: 'info',
}

const mergedOutcome = (
  loaded: boolean,
  deployments: Deployment[],
): { title: string; tone: ShipTone } => {
  if (!loaded || deployments.length === 0) {
    return {
      title: 'Merged; production starts deploying when GitHub sends the push',
      tone: 'info',
    }
  }

  if (deployments.some((d) => d.status === 'failed' || d.status === 'cancelled')) {
    return {
      title: 'Merged, but the production deploy did not finish',
      tone: 'danger',
    }
  }

  if (deployments.some((d) => isInFlight(d.status))) {
    return {
      title: 'Merged; production is deploying',
      tone: 'info',
    }
  }

  return {
    title: 'Merged and live in production',
    tone: 'success',
  }
}

export const useShipStatus = (approval: ShipApproval) => {
  const state = shipState(approval)
  const merged = state === 'merged'
  const detail = useQuery({
    ...approvalQuery(approval.id),
    enabled: merged,
    refetchInterval: (query) => (query.state.data?.deployments?.length ? false : 3000),
  })
  const ids = detail.data?.deployments ?? []
  const results = useQueries({
    queries: ids.map((id) => deploymentQuery(id)),
  })
  const deployments = results.flatMap((r) => (r.data ? [r.data] : []))
  const loaded = detail.isSuccess && deployments.length === ids.length

  return {
    state,
    deployments,
    ...(merged
      ? mergedOutcome(loaded, deployments)
      : {
          title: shipStatusText[state],
          tone: shipTone[state],
        }),
  }
}

export function ShipDeployments({ deployments }: { deployments: Deployment[] }) {
  return deployments.map((d) => (
    <Button key={d.id} asChild size="sm" variant="outline">
      <Link
        to="/deployments/$deployment"
        params={{
          deployment: d.id,
        }}
      >
        <Rocket /> Deployment #{d.number}
      </Link>
    </Button>
  ))
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
