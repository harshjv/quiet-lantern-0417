import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, failureText, idempotency, unwrap } from '@/lib/api'

export type ShipRequest = Awaited<ReturnType<typeof listShipRequests>>['items'][number]

const listShipRequests = () => unwrap(api.v1['ship-requests'].get())

export const shipRequestsQuery = {
  queryKey: ['ship-requests'],
  queryFn: listShipRequests,
}

export const useShipRequests = (enabled: boolean) =>
  useQuery({
    ...shipRequestsQuery,
    enabled,
  }).data?.items ?? []

export const shipStatusText: Record<ShipRequest['status'], string> = {
  pushing: 'Pushing the branch and opening the pull request',
  pending: 'Waiting for an admin to approve',
  rejected: 'Not shipped',
  merged: 'Merged; production is deploying',
  failed: 'Ship it did not finish',
}

export function PullRequestLink({ request }: { request: ShipRequest }) {
  return request.pull_request ? (
    <Button asChild size="sm" variant="outline">
      <a href={request.pull_request.url} target="_blank" rel="noreferrer">
        <ExternalLink /> #{request.pull_request.number}
      </a>
    </Button>
  ) : null
}

export function ShipDecision({ request }: { request: ShipRequest }) {
  const queries = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      unwrap(
        api.v1['ship-requests']({
          request: request.id,
        }).decision.post(
          {
            decision,
            ...(decision === 'reject' && reason.trim()
              ? {
                  reason: reason.trim(),
                }
              : {}),
          },
          idempotency(),
        ),
      ),
    onSuccess: () => {
      setProblem(null)
      void queries.invalidateQueries({
        queryKey: ['ship-requests'],
      })
      void queries.invalidateQueries({
        queryKey: ['tasks'],
      })
    },
    onError: (error) => setProblem(failureText(error)),
  })

  if (rejecting) {
    return (
      <span className="flex items-center gap-2">
        <Input
          className="w-64"
          value={reason}
          placeholder="Why not, for the task's owner"
          aria-label="Reason"
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate('reject')}
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
      {problem && <span className="text-sm text-destructive">{problem}</span>}
      <PullRequestLink request={request} />
      {request.head_sha && (
        <span className="font-mono text-xs text-muted-foreground">
          at {request.head_sha.slice(0, 7)}
        </span>
      )}
      <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
        <X /> Reject
      </Button>
      <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
        <Check /> Approve and merge
      </Button>
    </span>
  )
}
