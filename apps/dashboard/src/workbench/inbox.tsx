import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
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

import { Name } from '@/components/name'
import { Rows } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { failureText, type Approval, type Me } from '@/lib/api'
import { approvalHeadline, approvalPlace, type Names, type Places } from '@/lib/changes'
import { changeSummary, shortAgo } from '@/lib/format'
import { actorText, approvalSource, approvalStatus } from '@/lib/labels'
import { taskTo } from '@/lib/links'
import { approvalsQuery, meQuery, projectsQuery } from '@/lib/queries'
import type { Tone } from '@/lib/tone'

import { deciderOf } from './approval-actions'
import { useProjectList, useTaskRows, type Task } from './data'
import { useNames, usePlaces } from './names'
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

export const inboxGroups = ['needs-you', 'waiting', 'failed', 'finished'] as const

type Group = (typeof inboxGroups)[number]

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

const groups: { id: Group; label: string }[] = [
  {
    id: 'needs-you',
    label: 'Needs you',
  },
  {
    id: 'waiting',
    label: 'Waiting',
  },
  {
    id: 'failed',
    label: 'Failed',
  },
  {
    id: 'finished',
    label: 'Finished',
  },
]

const counted: Group[] = ['needs-you', 'failed']

const taskShapes: Partial<Record<Task['state'], { group: Group; icon: LucideIcon; tone: Tone }>> = {
  waiting: {
    group: 'needs-you',
    icon: MessageCircleQuestion,
    tone: 'warning',
  },
  failed: {
    group: 'failed',
    icon: CircleX,
    tone: 'danger',
  },
  finished: {
    group: 'finished',
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
            title: (
              <Name kind="task" chip={false}>
                {t.title}
              </Name>
            ),
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
                <Link {...taskTo(t.project, t.id)}>Open</Link>
              </Button>
            ),
          },
        ]
      : []
  })

const approvalFacts = (
  approval: Approval,
  names: Names,
  places: Places,
  status?: string,
): Fact[] => [
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
    text: approvalPlace(approval, names, places),
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
  const names = useNames([approval.project_id])
  const places = usePlaces([approval.project_id])

  return (
    <Link
      to="/approvals/$approval"
      params={{
        approval: approval.id,
      }}
      className="truncate underline-offset-4 hover:underline"
    >
      {approvalHeadline(approval, names, places)}
    </Link>
  )
}

function Review({ approval }: { approval: Approval }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link
        to="/approvals/$approval"
        params={{
          approval: approval.id,
        }}
      >
        Review
      </Link>
    </Button>
  )
}

const waitingNote = (blocked: boolean) => (
  <span className="text-sm text-muted-foreground">
    {blocked ? 'Another admin approves' : 'Waiting for an admin'}
  </span>
)

const approvalItem = (approval: Approval, me: Me | undefined, names: Names, places: Places) => {
  const decider = deciderOf(me, approval)
  const yours = decider.can && !decider.blocked

  if (approval.source === 'task') {
    const state = shipState(approval)
    const failed = state === 'failed'

    return {
      id: approval.id,
      group: failed ? 'failed' : yours && state === 'open' ? 'needs-you' : 'waiting',
      icon: Rocket,
      tone: failed ? 'danger' : 'warning',
      title: <ApprovalTitle approval={approval} />,
      label: approval.title,
      meta: approvalFacts(approval, names, places, shipProblem(approval) ?? shipStatusText[state]),
      action: (
        <>
          {approval.task_id && approval.project_id && names.has(approval.project_id) && (
            <Button asChild size="sm" variant="ghost">
              <Link {...taskTo(names.get(approval.project_id)!, approval.task_id)}>Open task</Link>
            </Button>
          )}
          <ShipDecision approval={approval} />
        </>
      ),
    } satisfies Item
  }

  return {
    id: approval.id,
    group: yours ? 'needs-you' : 'waiting',
    icon: InboxIcon,
    tone: 'warning',
    title: <ApprovalTitle approval={approval} />,
    label: approval.title,
    meta: approvalFacts(approval, names, places),
    action: (
      <>
        {!yours && waitingNote(decider.can && decider.blocked)}
        <Review approval={approval} />
      </>
    ),
  } satisfies Item
}

function useProjectNames(): Names {
  const projects = useQuery(projectsQuery)

  return new Map((projects.data?.items ?? []).map((p) => [p.id, p.name]))
}

const inProject = (approval: Approval, project: string | null, names: Names) =>
  !project || (approval.project_id !== null && names.get(approval.project_id) === project)

export function useInbox(project: string | null) {
  const rows = useTaskRows()
  const me = useQuery(meQuery)
  const approvals = useQuery(approvalsQuery('waiting'))
  const names = useProjectNames()
  const places = usePlaces((approvals.data?.items ?? []).map((a) => a.project_id))
  const items = [
    ...(approvals.data?.items ?? [])
      .filter((a) => inProject(a, project, names))
      .map((a) => approvalItem(a, me.data, names, places)),
    ...taskItems(rows.filter((t) => !project || t.project === project)),
  ]

  return {
    items,
    pending: approvals.isPending,
    error: approvals.error,
  }
}

export const useInboxCount = (project: string | null) =>
  useInbox(project).items.filter((i) => counted.includes(i.group)).length

const useInboxSearch = () => {
  const search = useSearch({
    from: '/_app/_outside/inbox',
  })
  const navigate = useNavigate()
  const set = (next: Partial<typeof search>) =>
    void navigate({
      to: '/inbox',
      search: (prev) => ({
        ...prev,
        ...next,
      }),
    })

  return {
    search,
    set,
  }
}

function WaitingItems() {
  const { search, set } = useInboxSearch()
  const { items, pending, error } = useInbox(search.project ?? null)
  const filter = search.group ?? 'all'
  const [cleared, setCleared] = useState<string[]>([])
  const open = items.filter((i) => !cleared.includes(i.id))
  const shown = groups.filter((g) => filter === 'all' || g.id === filter)

  return (
    <PageTabs
      value={filter}
      onValueChange={(v) =>
        set({
          group: inboxGroups.find((g) => g === v),
        })
      }
    >
      <TabsList>
        <TabsTrigger value="all">All {open.length}</TabsTrigger>
        {groups.map((g) => (
          <TabsTrigger key={g.id} value={g.id}>
            {g.label} {open.filter((i) => i.group === g.id).length}
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
          <p className="text-sm text-muted-foreground">Nothing waiting on you</p>
        ) : (
          shown.map((g) => {
            const rows = open.filter((i) => i.group === g.id)
            const list = (
              <ItemList key={g.id}>
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
                        {i.group === 'finished' && (
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
            )

            if (rows.length === 0) {
              return null
            }

            return filter === 'all' ? (
              <Section key={g.id} title={g.label} count={rows.length}>
                {list}
              </Section>
            ) : (
              list
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
  const { search, set } = useInboxSearch()
  const project = search.project ?? null
  const status = search.status ?? 'approved'
  const approvals = useQuery(approvalsQuery(status))
  const names = useProjectNames()
  const places = usePlaces((approvals.data?.items ?? []).map((a) => a.project_id))
  const rows = (approvals.data?.items ?? []).filter((a) => inProject(a, project, names))

  return (
    <PageTabs
      value={status}
      onValueChange={(v) =>
        set({
          status: decidedStatuses.find((s) => s === v),
        })
      }
    >
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
                  places,
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

const allProjects = ':all'

function ProjectFilter({
  project,
  onChange,
}: {
  project: string | null
  onChange: (project: string | undefined) => void
}) {
  const projects = useProjectList()

  return (
    <Select
      value={project ?? allProjects}
      onValueChange={(v) => onChange(v === allProjects ? undefined : v)}
    >
      <SelectTrigger className="w-48" aria-label="Project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={allProjects}>All projects</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function Inbox() {
  const { search, set } = useInboxSearch()
  const view = search.view ?? 'waiting'

  return (
    <PageTabs
      value={view}
      onValueChange={(v) =>
        set({
          view: v === 'history' ? 'history' : undefined,
        })
      }
      className="contents"
    >
      <Page
        title="Inbox"
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <ProjectFilter
              project={search.project ?? null}
              onChange={(project) =>
                set({
                  project,
                })
              }
            />
            <TabsList>
              <TabsTrigger value="waiting">Current</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
          </span>
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
