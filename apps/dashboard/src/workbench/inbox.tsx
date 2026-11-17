import { useQuery } from '@tanstack/react-query'
import {
  CircleCheck,
  CircleX,
  Inbox as InboxIcon,
  MessageCircleQuestion,
  Rocket,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Rows } from '@/components/page'
import { PlaceLink } from '@/components/place-link'
import { Button } from '@/components/ui/button'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { failureText, type Approval, type Me } from '@/lib/api'
import { changeSummary, shortAgo } from '@/lib/format'
import { actorText, approvalSource, approvalStatus } from '@/lib/labels'
import { places, usePlace } from '@/lib/nav'
import { approvalsQuery, meQuery, projectsQuery } from '@/lib/queries'
import type { Tone } from '@/lib/tone'

import { deciderOf } from './approval-actions'
import { useTaskRows, type Task } from './data'
import {
  ItemList,
  ItemRow,
  Notice,
  Page,
  PageTabPanel,
  PageTabs,
  Section,
  StatusPill,
  type Fact,
} from './parts'
import { ShipDecision, shipProblem, shipState, shipStatusText } from './ship-approval'

type Group = 'decide' | 'others' | 'broken' | 'done'

type Item = {
  id: string
  group: Group
  icon: LucideIcon
  tone: Tone
  title: ReactNode
  label: string
  meta: Fact[]
  action: ReactNode
}

type Decided = Exclude<Approval['status'], 'waiting'>

const decidedStatuses: Decided[] = ['approved', 'rejected', 'superseded']

const groups: { id: Group; title: string; tab: string }[] = [
  {
    id: 'decide',
    title: 'Needs your decision',
    tab: 'Decide',
  },
  {
    id: 'others',
    title: 'Waiting on someone else',
    tab: 'Waiting',
  },
  {
    id: 'broken',
    title: 'Something broke',
    tab: 'Broken',
  },
  {
    id: 'done',
    title: 'Finished',
    tab: 'Done',
  },
]

const counted: Group[] = ['decide', 'broken']

const taskShapes: Partial<Record<Task['state'], { group: Group; icon: LucideIcon; tone: Tone }>> = {
  waiting: {
    group: 'decide',
    icon: MessageCircleQuestion,
    tone: 'warning',
  },
  failed: {
    group: 'broken',
    icon: CircleX,
    tone: 'danger',
  },
  finished: {
    group: 'done',
    icon: CircleCheck,
    tone: 'success',
  },
}

const taskItems = (rows: Task[]) =>
  rows.flatMap((t): Item[] => {
    const shape = taskShapes[t.state]

    return shape
      ? [
          {
            id: t.id,
            ...shape,
            title: t.title,
            label: t.title,
            meta: [
              {
                kind: 'status',
                text: t.reason,
              },
              {
                kind: 'project',
                text: t.project,
              },
              {
                kind: 'time',
                text: t.age,
              },
            ],
            action: (
              <Button asChild size="sm">
                <PlaceLink to={places.task(t.id)}>Open</PlaceLink>
              </Button>
            ),
          },
        ]
      : []
  })

const projectText = (approval: Approval, names: Map<string, string>) =>
  approval.project_id
    ? `${names.get(approval.project_id) ?? approval.project_id} / production`
    : 'Platform'

const approvalFacts = (approval: Approval, names: Map<string, string>, status?: string): Fact[] => [
  ...(status
    ? [
        {
          kind: 'status' as const,
          text: status,
        },
      ]
    : []),
  {
    kind: 'project',
    text: projectText(approval, names),
  },
  {
    kind: 'user',
    text: actorText(approval.requested_by),
  },
  {
    kind: 'via',
    text: approvalSource[approval.source],
  },
  ...(approval.source === 'task'
    ? []
    : [
        {
          kind: 'files' as const,
          text: changeSummary(approval.summary),
        },
      ]),
  {
    kind: 'time',
    text: shortAgo(approval.created_at),
  },
]

function ApprovalTitle({ approval }: { approval: Approval }) {
  return (
    <PlaceLink
      to={places.approval(approval.id)}
      className="truncate underline-offset-4 hover:underline"
    >
      {approval.title}
    </PlaceLink>
  )
}

function Review({ approval }: { approval: Approval }) {
  return (
    <Button asChild size="sm" variant="outline">
      <PlaceLink to={places.approval(approval.id)}>Review</PlaceLink>
    </Button>
  )
}

const waitingNote = (blocked: boolean) => (
  <span className="text-sm text-muted-foreground">
    {blocked ? 'Another admin approves' : 'Waiting for an admin'}
  </span>
)

const approvalItem = (approval: Approval, me: Me | undefined, names: Map<string, string>) => {
  const decider = deciderOf(me, approval)
  const yours = decider.can && !decider.blocked

  if (approval.source === 'task') {
    const state = shipState(approval)
    const failed = state === 'failed'

    return {
      id: approval.id,
      group: failed ? 'broken' : yours && state === 'open' ? 'decide' : 'others',
      icon: Rocket,
      tone: failed ? 'danger' : 'warning',
      title: <ApprovalTitle approval={approval} />,
      label: approval.title,
      meta: approvalFacts(approval, names, shipProblem(approval) ?? shipStatusText[state]),
      action: (
        <>
          {approval.task_id && (
            <Button asChild size="sm" variant="ghost">
              <PlaceLink to={places.task(approval.task_id)}>Open task</PlaceLink>
            </Button>
          )}
          <ShipDecision approval={approval} />
        </>
      ),
    } satisfies Item
  }

  return {
    id: approval.id,
    group: yours ? 'decide' : 'others',
    icon: InboxIcon,
    tone: 'warning',
    title: <ApprovalTitle approval={approval} />,
    label: approval.title,
    meta: approvalFacts(approval, names),
    action: (
      <>
        {!yours && waitingNote(decider.can && decider.blocked)}
        <Review approval={approval} />
      </>
    ),
  } satisfies Item
}

function useProjectNames() {
  const projects = useQuery(projectsQuery)

  return new Map((projects.data?.items ?? []).map((p) => [p.id, p.name]))
}

const inProject = (approval: Approval, project: string | null, names: Map<string, string>) =>
  !project || (approval.project_id !== null && names.get(approval.project_id) === project)

export function useInbox() {
  const { project } = usePlace()
  const rows = useTaskRows()
  const me = useQuery(meQuery)
  const approvals = useQuery(approvalsQuery('waiting'))
  const names = useProjectNames()
  const items = [
    ...(approvals.data?.items ?? [])
      .filter((a) => inProject(a, project, names))
      .map((a) => approvalItem(a, me.data, names)),
    ...taskItems(rows.filter((t) => !project || t.project === project)),
  ]

  return {
    items,
    pending: approvals.isPending,
    error: approvals.error,
  }
}

export const useInboxCount = () => useInbox().items.filter((i) => counted.includes(i.group)).length

function WaitingItems() {
  const { items, pending, error } = useInbox()
  const [filter, setFilter] = useState<Group | 'all'>('all')
  const [cleared, setCleared] = useState<string[]>([])
  const open = items.filter((i) => !cleared.includes(i.id))
  const shown = groups.filter((g) => filter === 'all' || g.id === filter)

  return (
    <PageTabs value={filter} onValueChange={(v) => setFilter(v as Group | 'all')}>
      <TabsList>
        <TabsTrigger value="all">All {open.length}</TabsTrigger>
        {groups.map((g) => (
          <TabsTrigger key={g.id} value={g.id}>
            {g.tab} {open.filter((i) => i.group === g.id).length}
          </TabsTrigger>
        ))}
      </TabsList>
      <PageTabPanel value={filter}>
        {error && (
          <Notice tone="danger" title="Couldn’t load approvals">
            {failureText(error)}
          </Notice>
        )}

        {pending ? (
          <Rows count={3} />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is waiting on you. Changes to production, questions from agents, work waiting to
            ship and tasks that failed show up here.
          </p>
        ) : (
          shown.map((g) => {
            const rows = open.filter((i) => i.group === g.id)

            return (
              rows.length > 0 && (
                <Section key={g.id} title={g.title} count={rows.length}>
                  <ItemList>
                    {rows.map((i) => (
                      <ItemRow
                        key={i.id}
                        icon={i.icon}
                        tone={i.tone}
                        title={i.title}
                        meta={i.meta}
                        action={
                          <>
                            {i.action}
                            {i.group === 'done' && (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Clear ${i.label}`}
                                onClick={() => setCleared([...cleared, i.id])}
                              >
                                <X />
                              </Button>
                            )}
                          </>
                        }
                      />
                    ))}
                  </ItemList>
                </Section>
              )
            )
          })
        )}
      </PageTabPanel>
    </PageTabs>
  )
}

const decidedIcon: Record<Decided, LucideIcon> = {
  approved: CircleCheck,
  rejected: CircleX,
  superseded: InboxIcon,
}

function History() {
  const { project } = usePlace()
  const [status, setStatus] = useState<Decided>('approved')
  const approvals = useQuery(approvalsQuery(status))
  const names = useProjectNames()
  const rows = (approvals.data?.items ?? []).filter((a) => inProject(a, project, names))

  return (
    <PageTabs value={status} onValueChange={(v) => setStatus(v as Decided)}>
      <TabsList>
        {decidedStatuses.map((s) => (
          <TabsTrigger key={s} value={s}>
            {approvalStatus[s].label}
          </TabsTrigger>
        ))}
      </TabsList>
      <PageTabPanel value={status}>
        {approvals.error ? (
          <Notice tone="danger" title="Couldn’t load approvals">
            {failureText(approvals.error)}
          </Notice>
        ) : approvals.isPending ? (
          <Rows count={3} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No {approvalStatus[status].label.toLowerCase()} approvals
            {project ? ` in ${project}` : ''}.
          </p>
        ) : (
          <ItemList>
            {rows.map((a) => (
              <ItemRow
                key={a.id}
                icon={decidedIcon[status]}
                tone={approvalStatus[status].tone}
                title={<ApprovalTitle approval={a} />}
                meta={approvalFacts(
                  a,
                  names,
                  a.status === 'rejected' ? (a.reason ?? undefined) : undefined,
                )}
                action={
                  <>
                    <StatusPill tone={approvalStatus[status].tone}>
                      {approvalStatus[status].label}
                    </StatusPill>
                    <Review approval={a} />
                  </>
                }
              />
            ))}
          </ItemList>
        )}
      </PageTabPanel>
    </PageTabs>
  )
}

export function Inbox() {
  const [view, setView] = useState<'waiting' | 'history'>('waiting')

  return (
    <PageTabs
      value={view}
      onValueChange={(v) => setView(v as 'waiting' | 'history')}
      className="contents"
    >
      <Page
        title="Inbox"
        actions={
          <TabsList>
            <TabsTrigger value="waiting">Waiting</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        }
      >
        <PageTabPanel value="waiting">
          <WaitingItems />
        </PageTabPanel>
        <PageTabPanel value="history">
          <History />
        </PageTabPanel>
      </Page>
    </PageTabs>
  )
}
