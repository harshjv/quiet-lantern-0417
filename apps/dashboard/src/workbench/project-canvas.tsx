import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Background, ReactFlow } from '@xyflow/react'
import { format } from 'date-fns'
import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { agentLabel } from '@stationly/protocol'

import { Code } from '@/components/code'
import { Name } from '@/components/name'
import { Skeleton } from '@/components/ui/skeleton'
import type { Approval, Project, Task } from '@/lib/api'
import { layoutCanvas, size, type CanvasNode } from '@/lib/canvas-layout'
import { plural } from '@/lib/format'
import { newTaskTo, placeTo, taskTo } from '@/lib/links'
import type { LiveNetwork } from '@/lib/network-live'
import { isProduction, type PlaceView } from '@/lib/place'
import { networkQuery, projectApprovalsQuery, projectTasksQuery } from '@/lib/queries'
import { countPill, toneDot, toneText, toneWash } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { CanvasProject, edgeTypes, nodeTypes } from './canvas-nodes'
import { Lane, LaneHead, ServerChip } from './canvas-parts'
import { asRow, taskTone } from './data'

export type CanvasProjectData = Pick<
  Project,
  'id' | 'name' | 'servers' | 'task_slots' | 'task_egress' | 'waiting_approvals'
>

const pad = 24

const nodeWidth = (node: CanvasNode) =>
  node.type === 'server' ? (node.width ?? 0) : size[node.type].width

const nodeHeight = (node: CanvasNode) =>
  node.type === 'server' ? node.data.height : size[node.type].height

const boundsOf = (nodes: CanvasNode[]) => {
  if (!nodes.length) {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    }
  }

  const x = Math.min(...nodes.map((node) => node.position.x))
  const y = Math.min(...nodes.map((node) => node.position.y))

  return {
    x,
    y,
    width: Math.max(...nodes.map((node) => node.position.x + nodeWidth(node))) - x,
    height: Math.max(...nodes.map((node) => node.position.y + nodeHeight(node))) - y,
  }
}

const useWidth = () => {
  const [width, setWidth] = useState(0)
  const frame = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return
    }

    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [width, frame] as const
}

const approvalBadges = (approvals: Approval[]) => {
  const badges = new Map<string, string>()

  for (const approval of approvals) {
    if (approval.status !== 'waiting') {
      continue
    }

    for (const change of approval.changes ?? []) {
      for (const id of [change.id, change.parent]) {
        if (typeof id === 'string') {
          badges.set(id, 'Production change')
        }
      }
    }
  }

  return badges
}

const serversOf = (project: CanvasProjectData) => project.servers ?? []

export function AppsLane({
  place,
  project,
  live,
  focus,
  onAddApp,
}: {
  place: PlaceView
  project: CanvasProjectData
  live: LiveNetwork
  focus: string | null
  onAddApp: () => void
}) {
  const { data: map } = useSuspenseQuery(networkQuery(place))
  const approvals = useQuery({
    ...projectApprovalsQuery(place.project),
    enabled: isProduction(place),
  })
  const { resolvedTheme } = useTheme()
  const heard = live.at !== null
  const disconnected = heard && live.state !== 'live'
  const servers = serversOf(project)
  const layout = useMemo(
    () =>
      layoutCanvas({
        servers,
        apps: map.apps,
        references: map.edges,
        samples: heard ? live.samples : null,
        badges: approvalBadges(isProduction(place) ? (approvals.data?.items ?? []) : []),
        focus,
      }),
    [servers, map, heard, live.samples, approvals.data, focus, place],
  )
  const shape = layout.nodes.map((node) => node.id).join(' ')
  const bounds = boundsOf(layout.nodes)
  const [width, frame] = useWidth()
  const fits = width > 0 && bounds.width + pad * 2 <= width
  const laneServers = servers.filter((server) =>
    map.apps.some((app) => app.server_id === server.id),
  )

  return (
    <Lane>
      <LaneHead label="Apps">
        {laneServers.length === 1 && <ServerChip server={laneServers[0]!} />}
        {disconnected && live.at && (
          <span className="border px-2 py-0.5 text-xs text-muted-foreground">
            As of {format(new Date(live.at), 'HH:mm')}
          </span>
        )}
      </LaneHead>
      {map.apps.length === 0 ? (
        <button
          type="button"
          onClick={onAddApp}
          className="flex h-24 items-center justify-center gap-2 border border-dashed text-sm font-medium text-muted-foreground hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Plus className="size-4" aria-hidden /> Add an app
        </button>
      ) : (
        <CanvasProject.Provider value={place.projectName}>
          <div
            ref={frame}
            style={{
              height: `clamp(14rem, ${bounds.height + pad * 2}px, ${focus ? 56 : 40}rem)`,
            }}
            data-testid="project-canvas"
          >
            <ReactFlow
              key={`${shape} ${fits}`}
              className="network-canvas"
              nodes={layout.nodes}
              edges={layout.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              panOnDrag
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              fitView={fits}
              defaultViewport={{
                x: pad - bounds.x,
                y: pad - bounds.y,
                zoom: 1,
              }}
              translateExtent={[
                [bounds.x - pad, bounds.y - pad],
                [bounds.x + bounds.width + pad, bounds.y + bounds.height + pad],
              ]}
              minZoom={1}
              maxZoom={1}
              proOptions={{
                hideAttribution: true,
              }}
              aria-label={`Apps of ${place.previewName ?? 'production'}`}
            >
              <Background gap={20} />
            </ReactFlow>
          </div>
        </CanvasProject.Provider>
      )}
    </Lane>
  )
}

export function AppsLaneLoading() {
  return (
    <Lane>
      <LaneHead label="Apps">
        <Skeleton className="h-6 w-16" />
      </LaneHead>
      <div
        className="grid h-56 grid-cols-4 items-center gap-6"
        aria-busy="true"
        aria-label="Loading"
      >
        <Skeleton className="h-16" />
        <Skeleton className="h-20" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-24" />
      </div>
    </Lane>
  )
}

const waitingBadge = (task: Task) => {
  if (task.ship?.status === 'waiting') {
    return 'Ship it?'
  }

  if (task.status !== 'waiting') {
    return null
  }

  switch (task.attention?.kind) {
    case 'permission':
      return 'Approve a tool'
    case 'plan':
      return 'Approve the plan'
    case 'question':
      return 'Question'
    default:
      return 'Needs you'
  }
}

function SlotsChip({ project }: { project: CanvasProjectData }) {
  const slots = project.task_slots
  const server = serversOf(project).find((s) => s.id === slots?.server_id)
  const full = slots ? slots.busy >= slots.total : false
  const count = slots && (
    <span className={cn('tabular-nums', full ? toneText.warning : 'text-muted-foreground')}>
      {slots.busy} of {plural(slots.total, 'slot')}
    </span>
  )

  if (!slots) {
    return null
  }

  return server ? <ServerChip server={server}>{count}</ServerChip> : count
}

function EdgeBox({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode
  title: string
  count?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border border-dashed bg-muted/40 px-3 py-3 text-sm">
      <span className="flex items-center gap-2 font-medium">
        {icon}
        {title}
        {count}
      </span>
      {children}
    </div>
  )
}

const heldBack: [string, boolean][] = [
  ['Claude key', true],
  ['Stationly token', true],
  ['GitHub token', false],
]

const shownDomains = 3

function AllowedDomains({ egress }: { egress: NonNullable<Project['task_egress']> }) {
  const names = egress.domains.map((d) => (d.wildcard ? `*.${d.domain}` : d.domain))
  const extra = names.length - shownDomains

  return (
    <EdgeBox
      icon={<ShieldCheck className={cn('size-4', toneText.success)} aria-hidden />}
      title="Allowed domains"
      count={
        egress.mode === 'allowlist' && (
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {plural(names.length, 'domain')}
          </span>
        )
      }
    >
      {egress.mode === 'open' ? (
        <span className="text-xs text-muted-foreground">Any host</span>
      ) : (
        <span className="flex min-w-0 gap-1.5 text-xs">
          <span className="flex min-w-0 flex-wrap gap-1">
            {names.slice(0, shownDomains).map((name) => (
              <Code key={name} className="text-xs">
                {name}
              </Code>
            ))}
          </span>
          {extra > 0 && <span className="shrink-0 text-muted-foreground">+{extra}</span>}
        </span>
      )}
    </EdgeBox>
  )
}

export function TasksLane({ project }: { project: CanvasProjectData }) {
  const tasks = useQuery(projectTasksQuery(project.name))
  const items = (tasks.data?.items ?? []).filter((task) => !task.archived_at)

  return (
    <Lane className="border-t">
      <LaneHead label="Tasks">
        <SlotsChip project={project} />
      </LaneHead>
      <div className="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
        <div className="min-w-0 flex-1">
          {tasks.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : items.length === 0 ? (
            <Link
              {...newTaskTo(project.name)}
              className="flex h-14 items-center justify-center gap-2 border border-dashed text-sm font-medium text-muted-foreground hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Plus className="size-4" aria-hidden /> Start a task
            </Link>
          ) : (
            <TaskRows project={project.name} tasks={items} />
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-3 @4xl:w-64">
          <EdgeBox
            icon={<KeyRound className="size-4 text-muted-foreground" aria-hidden />}
            title="Secret values proxy"
          >
            <dl className="flex flex-col gap-0.5 text-xs">
              {heldBack.map(([name, held]) => (
                <div key={name} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-muted-foreground">{name}</dt>
                  <dd className={cn(!held && 'text-muted-foreground')}>
                    {held ? 'Held back' : 'Not yet'}
                  </dd>
                </div>
              ))}
            </dl>
          </EdgeBox>
          {project.task_egress && <AllowedDomains egress={project.task_egress} />}
        </div>
      </div>
    </Lane>
  )
}

function TaskRows({ project, tasks }: { project: string; tasks: Task[] }) {
  return (
    <table className="w-full border-separate border-spacing-y-1.5 text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="w-6 font-normal">
            <span className="sr-only">Status</span>
          </th>
          <th className="font-normal">Task</th>
          <th className="hidden pr-3 font-normal @xl:table-cell">Agent</th>
          <th className="hidden pr-3 font-normal @2xl:table-cell">Preview</th>
          <th className="pr-3 text-right font-normal">Since</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const row = asRow(task)
          const badge = waitingBadge(task)

          return (
            <tr
              key={task.id}
              className={cn(
                'relative bg-muted/50 focus-within:bg-muted hover:bg-muted',
                badge && toneWash.warning,
              )}
            >
              <td className="py-3 pl-3">
                <span className={cn('block size-2', toneDot[taskTone[row.state]])} />
                <span className="sr-only">{row.reason}</span>
              </td>
              <td className="w-full max-w-0 py-3 pl-1">
                <span className="flex min-w-0 items-center gap-2">
                  <Link
                    {...taskTo(project, task.id)}
                    className="min-w-0 truncate font-medium after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    <Name kind="task" chip={false}>
                      {task.title}
                    </Name>
                  </Link>
                  {badge && (
                    <span className={cn('h-5 shrink-0 px-2 text-xs', countPill)}>{badge}</span>
                  )}
                </span>
              </td>
              <td className="hidden pr-3 whitespace-nowrap text-muted-foreground @xl:table-cell">
                {agentLabel(task.agent)}
              </td>
              <td className="hidden pr-3 whitespace-nowrap @2xl:table-cell">
                {task.preview ? (
                  <Link
                    {...placeTo(project, task.preview.name)}
                    className="relative z-10 underline-offset-4 hover:underline"
                  >
                    {task.preview.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
              </td>
              <td className="pr-3 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                {task.status === 'queued' ? 'Queued' : row.age}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
