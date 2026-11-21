import { useQueries, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Rocket } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Actor } from '@/components/actor'
import { Code } from '@/components/code'
import { ChangeDiff } from '@/components/diff'
import { KeyValue } from '@/components/page'
import { DeploymentStatusBadge } from '@/components/status'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import type { Approval, Deployment } from '@/lib/api'
import {
  approvalHeadline,
  approvalPlace,
  approvalPreview,
  type Names,
  type Places,
} from '@/lib/changes'
import { changeSummary, plural, shortSha, stamp } from '@/lib/format'
import { approvalSource, approvalStatus } from '@/lib/labels'
import { placeTo, taskTo } from '@/lib/links'
import { approvalQuery, deploymentQuery } from '@/lib/queries'

import { ApproveButton, RejectDialog, useDecider, useDecision } from './approval-actions'
import { useNames, usePlaces } from './names'
import { ItemList, ItemRow, Notice, Page, PageBoundary, Section, StatusPill } from './parts'
import { PullRequestLink, ShipDecision, shipProblem, useShipStatus } from './ship-approval'

type Fact = [string, ReactNode]

function BackToInbox() {
  return (
    <Button asChild size="sm" variant="ghost" className="self-start">
      <Link to="/inbox">
        <ArrowLeft /> Inbox
      </Link>
    </Button>
  )
}

function Scope({ approval, names, places }: { approval: Approval; names: Names; places: Places }) {
  const project = approval.project_id ? names.get(approval.project_id) : undefined
  const text = approvalPlace(approval, names, places)

  return project ? (
    <Link
      {...placeTo(project, approvalPreview(approval.changes, places))}
      className="underline-offset-4 hover:underline"
    >
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  )
}

function Decide({
  approval,
  onApplied,
}: {
  approval: Approval
  onApplied: (deployments: Deployment[]) => void
}) {
  const decider = useDecider(approval)
  const decide = useDecision(approval.id, (deployments, body) => {
    if (body.decision === 'approve') {
      onApplied(deployments)
    }
  })
  const approving = decide.isPending && decide.variables?.decision === 'approve'

  if (!decider.can) {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      <RejectDialog
        pending={decide.isPending && !approving}
        disabled={decide.isPending}
        onReject={(decision) => decide.mutate(decision)}
      />
      {decider.blocked ? (
        <span className="text-sm text-muted-foreground">Another admin approves</span>
      ) : (
        <ApproveButton
          label="Approve and apply"
          pending={approving}
          disabled={decide.isPending}
          onApprove={() =>
            decide.mutate({
              decision: 'approve',
            })
          }
        />
      )}
    </div>
  )
}

function Deployments({ ids }: { ids: string[] }) {
  const deployments = useQueries({
    queries: ids.map((id) => deploymentQuery(id)),
  })

  return (
    <Section title="Deployments" count={ids.length}>
      <ItemList>
        {ids.map((id, index) => {
          const deployment = deployments[index]?.data

          return (
            <ItemRow
              key={id}
              icon={Rocket}
              title={
                <Link
                  to="/deployments/$deployment"
                  params={{
                    deployment: id,
                  }}
                  className="underline-offset-4 hover:underline"
                >
                  {deployment ? `Deployment #${deployment.number}` : id}
                </Link>
              }
              action={deployment && <DeploymentStatusBadge status={deployment.status} />}
            />
          )
        })}
      </ItemList>
    </Section>
  )
}

function Ship({ approval, project }: { approval: Approval; project: string | undefined }) {
  const status = useShipStatus(approval)
  const problem = shipProblem(approval)

  return (
    <Section title="Pull request">
      <Notice
        tone={problem && status.state !== 'merged' ? 'danger' : status.tone}
        title={status.title}
        action={
          approval.task_id &&
          project && (
            <Button asChild size="sm" variant="ghost">
              <Link {...taskTo(project, approval.task_id)}>Open task</Link>
            </Button>
          )
        }
      >
        <span className="flex flex-col gap-2">
          {problem && <span>{problem}</span>}
          <span className="flex flex-wrap items-center gap-2">
            {status.state === 'open' ? (
              <ShipDecision approval={approval} />
            ) : (
              <PullRequestLink approval={approval} />
            )}
            {approval.ship?.merge_sha && (
              <span className="text-xs text-muted-foreground">
                Merged <Code className="text-xs">{shortSha(approval.ship.merge_sha)}</Code>
              </span>
            )}
          </span>
        </span>
      </Notice>
    </Section>
  )
}

function ApprovalBody({ approvalId }: { approvalId: string }) {
  const { data: a } = useSuspenseQuery(approvalQuery(approvalId))
  const decider = useDecider(a)
  const [started, setStarted] = useState<Deployment[]>([])
  const task = a.source === 'task'
  const deployments = [...new Set([...(a.deployments ?? []), ...started.map((d) => d.id)])]
  const names = useNames([a.project_id])
  const places = usePlaces([a.project_id])

  return (
    <Page
      title={approvalHeadline(a, names, places)}
      actions={!task && <Decide approval={a} onApplied={setStarted} />}
    >
      <div className="-mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <StatusPill tone={approvalStatus[a.status].tone}>
          {approvalStatus[a.status].label}
        </StatusPill>
        <Scope approval={a} names={names} places={places} />
        <span>
          <Actor actor={a.requested_by} />
          <span className="ml-1.5 text-xs">{approvalSource[a.source]}</span>
        </span>
        <Time value={a.created_at} />
        {a.self_approved && <span>Self-approved</span>}
        <Code className="text-xs">{a.id}</Code>
      </div>

      {a.status === 'waiting' && decider.loaded && !decider.human && (
        <Notice tone="warning" title="Only a person can decide on this change">
          Sign in as yourself; tokens can’t approve or reject.
        </Notice>
      )}

      {a.status === 'waiting' && decider.human && !decider.can && (
        <Notice tone="info" title="Waiting for an admin" />
      )}

      {a.status === 'rejected' && a.reason && !task && (
        <Notice tone="danger" title="Rejected">
          {a.reason}
        </Notice>
      )}

      {started.length > 0 && (
        <Notice tone="success" title="Change applied">
          Started {plural(started.length, 'deployment')}.
        </Notice>
      )}

      {task && <Ship approval={a} project={a.project_id ? names.get(a.project_id) : undefined} />}

      {!task && (
        <KeyValue
          framed
          items={[
            ['Changes', changeSummary(a.summary)],
            ['Created', stamp(a.created_at)],
            ...(a.decided_by
              ? [['Decided by', <Actor key="decided" actor={a.decided_by} />] as Fact]
              : []),
            ...(a.decided_at ? [['Decided', stamp(a.decided_at)] as Fact] : []),
          ]}
        />
      )}

      {deployments.length > 0 && <Deployments ids={deployments} />}

      {!task && (
        <Section title="Changes" note="Applied in this order, all or nothing.">
          {a.changes && a.changes.length > 0 ? (
            <ChangeDiff changes={a.changes} names={names} />
          ) : (
            <p className="text-sm text-muted-foreground">No changes</p>
          )}
        </Section>
      )}
    </Page>
  )
}

export function ApprovalPage({ approvalId }: { approvalId: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex px-4 pt-4">
        <BackToInbox />
      </div>
      <PageBoundary title="Couldn’t load this approval" resetKey={approvalId}>
        <ApprovalBody approvalId={approvalId} />
      </PageBoundary>
    </div>
  )
}
