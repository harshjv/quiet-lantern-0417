import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, type LinkOptions } from '@tanstack/react-router'
import { ArrowLeft, Bot } from 'lucide-react'

import { agentLabel } from '@stationly/protocol'

import { Code } from '@/components/code'
import { KeyValue, Rows } from '@/components/page'
import { Failure as LoadFailure } from '@/components/panel'
import {
  DeleteMachine,
  ExtendMachine,
  ForkButton,
  SnapshotMachine,
  StartMachine,
  StopMachine,
} from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { ProtectedNotice } from '@/components/sandboxes-panel'
import { MachineStatusBadge } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import type { Machine } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { blank, bytes, repositoryName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { machineNetwork, machineRuntime } from '@/lib/labels'
import { placeTo } from '@/lib/links'
import { scopeOf, type PlaceView } from '@/lib/place'
import { machineQuery, previewQueryOf, projectQuery } from '@/lib/queries'
import { egressText, imageText, sizeText } from '@/lib/sandbox'
import { isIdle, isLive } from '@/lib/status'

import { MachineTabs } from './machine-tabs'
import { machineUse, machineUseText, TaskLink, useMachineTasks } from './machine-use'
import { Notice, Page, Section } from './parts'

type Project = { id: string; name: string }

function placeOfMachine(machine: Machine, project: Project, previewName: string | undefined) {
  const place: PlaceView = {
    project: project.id,
    preview: machine.preview_id,
    projectName: project.name,
    previewName: machine.preview_id ? (previewName ?? machine.preview_id) : null,
  }
  const back = placeTo(project.name, place.previewName, 'machines')

  return {
    place,
    scope: scopeOf(place),
    back,
  }
}

export function MachinePage({ machineId, tab }: { machineId: string; tab: string | null }) {
  const machine = useQuery(machineQuery(machineId))
  const project = useQuery({
    ...projectQuery(machine.data?.project_id ?? ''),
    enabled: machine.data !== undefined,
  })
  const preview = useQuery({
    ...previewQueryOf(machine.data?.preview_id ?? ''),
    enabled: !!machine.data?.preview_id,
  })
  const error = machine.error ?? project.error

  if (error) {
    return (
      <Page title="Machine">
        <LoadFailure
          error={error}
          title="Couldn’t load this machine"
          onRetry={() => {
            void machine.refetch()
            void project.refetch()
          }}
        />
      </Page>
    )
  }

  if (!machine.data || !project.data) {
    return (
      <Page title="Machine">
        <Rows count={6} />
      </Page>
    )
  }

  return (
    <LoadedMachine
      machine={machine.data}
      project={project.data}
      previewName={preview.data?.name}
      tab={tab}
    />
  )
}

function LoadedMachine({
  machine,
  project,
  previewName,
  tab,
}: {
  machine: Machine
  project: Project
  previewName: string | undefined
  tab: string | null
}) {
  const { place, scope, back } = placeOfMachine(machine, project, previewName)

  return (
    <Page title={machine.name} actions={<Actions machine={machine} scope={scope} back={back} />}>
      <Heading machine={machine} place={place} back={back} />
      <ProtectedNotice place={place} />
      <Failure machine={machine} />
      {machine.workspace && <AgentSection machine={machine} scope={scope} />}
      <Overview machine={machine} />
      <MachineTabs machine={machine} scope={scope} tab={tab} />
    </Page>
  )
}

function Heading({
  machine,
  place,
  back,
}: {
  machine: Machine
  place: PlaceView
  back: LinkOptions
}) {
  return (
    <div className="-mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
      <Link
        {...back}
        className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {place.projectName} / {place.previewName ?? 'production'} machines
      </Link>
      <MachineStatusBadge status={machine.status} reason={machine.status_reason} />
      <span>{machineUseText[machineUse(machine)]}</span>
      <span data-testid="machine-time">
        <TimeLeft machine={machine} />
      </span>
      {machine.forked_from && (
        <Badge variant="outline" className="font-normal">
          Fork
        </Badge>
      )}
      <Code copy={machine.id} className="text-muted-foreground">
        {machine.id}
      </Code>
    </div>
  )
}

function Actions({ machine, scope, back }: { machine: Machine; scope: Scope; back: LinkOptions }) {
  const navigate = useNavigate()

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isIdle(machine.status) ? (
        <StartMachine machine={machine} />
      ) : isLive(machine.status) ? (
        <StopMachine machine={machine} />
      ) : null}
      <ExtendMachine machine={machine} />
      <SnapshotMachine machine={machine} />
      <ForkButton
        source={{
          kind: 'machine',
          machine,
        }}
        scope={scope}
      />
      <DeleteMachine machine={machine} after={() => void navigate(back)} />
    </div>
  )
}

function Failure({ machine }: { machine: Machine }) {
  if (!machine.failure) {
    return null
  }

  return (
    <Notice tone="danger" title={`${machine.name} failed`}>
      <span className="flex flex-col gap-1">
        <span className="text-foreground">{machine.failure.summary}</span>
        <span className="font-mono text-xs">{machine.failure.code}</span>
      </span>
    </Notice>
  )
}

function AgentSection({ machine, scope }: { machine: Machine; scope: Scope }) {
  const workspace = machine.workspace!
  const use = machineUse(machine)
  const tasks = useMachineTasks(machine)
  const shell = commands.machineShell(scope, machine.name)

  return (
    <Section
      icon={Bot}
      title={use === 'project' ? 'Tasks on this machine' : 'Its task'}
      count={use === 'project' ? tasks.length : undefined}
      note={
        use === 'project'
          ? 'The project machine. The project’s tasks run here, each in its own slot.'
          : 'This machine belongs to one task and goes away with it.'
      }
    >
      <KeyValue
        framed
        items={[
          ['Agent', agentLabel(workspace.agent)],
          [
            'Repository',
            workspace.repository ? (
              <Code key="r" copy={workspace.repository}>
                {repositoryName(workspace.repository)}
              </Code>
            ) : (
              blank
            ),
          ],
          [
            'Branch',
            workspace.branch ? (
              <Code key="b" copy={workspace.branch}>
                {workspace.branch}
              </Code>
            ) : (
              blank
            ),
          ],
          [
            'Folder',
            <Code key="p" copy={workspace.path}>
              {workspace.path}
            </Code>,
          ],
        ]}
      >
        <div className="flex flex-col gap-3">
          {tasks.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {tasks.map((task) => (
                <li key={task.id} className="flex items-center gap-2">
                  <entityIcon.conversation className="size-3.5 text-muted-foreground" aria-hidden />
                  <TaskLink task={task} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {use === 'project'
                ? 'No task runs here now.'
                : 'Its task is archived or not shared with you.'}
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Open a terminal on it
            <Code copy={shell}>{shell}</Code>
          </p>
        </div>
      </KeyValue>
    </Section>
  )
}

function Overview({ machine }: { machine: Machine }) {
  const metrics = machine.metrics

  return (
    <KeyValue
      framed
      items={[
        ['Image', <Code key="i">{imageText(machine.image)}</Code>],
        ['Size', sizeText(machine.size)],
        ['Runtime', machine.runtime ? machineRuntime[machine.runtime] : blank],
        ['Network', machineNetwork[machine.network]],
        ['Docker inside', machine.docker ? 'Yes' : 'No'],
        ['Outbound traffic', egressText(machine.egress)],
        ['Disk', `${bytes(machine.disk_used_bytes)} of ${bytes(machine.size.disk_bytes)}`],
        ['CPU', metrics ? `${metrics.cpu_pct.toFixed(1)}%` : 'not running'],
        [
          'Memory',
          metrics
            ? `${bytes(metrics.memory_bytes)} of ${bytes(metrics.memory_limit_bytes)}`
            : 'not running',
        ],
        [
          'Address',
          machine.address ? (
            <Code key="a" copy={machine.address}>
              {machine.address}
            </Code>
          ) : (
            'none'
          ),
        ],
      ]}
    />
  )
}
