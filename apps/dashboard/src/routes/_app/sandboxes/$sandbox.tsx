import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRight, CircleAlert, Ellipsis } from 'lucide-react'
import { lazy, useState, type ReactNode } from 'react'

import { agentLabel } from '@stationly/protocol'

import { AgentStatusBadge } from '@/components/agent-status'
import { AlsoWith, Code } from '@/components/code'
import { Crumbs } from '@/components/crumbs'
import { LogViewer } from '@/components/log-viewer'
import { EmptyState, KeyValue, PageHeader, Section } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import {
  CopiedFilesNotice,
  DeleteSandbox,
  ExtendSandbox,
  ForkButton,
  SnapshotSandbox,
  StartSandbox,
  StopSandbox,
} from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { SandboxNetwork } from '@/components/sandbox-network'
import { ProtectedNotice } from '@/components/sandboxes-panel'
import { SnapshotsTable } from '@/components/snapshots-table'
import { SandboxStatusBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import { WorkspaceSessions } from '@/components/workspace-sessions'
import { isInstanceAdmin } from '@/lib/agent-session'
import type { Sandbox } from '@/lib/api'
import { commands } from '@/lib/commands'
import { blank, bytes, repositoryName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { sandboxNetwork, sandboxRuntime, snapshotSource } from '@/lib/labels'
import { load, meQuery, sandboxOwnSnapshotsQuery, sandboxQuery } from '@/lib/queries'
import { egressText, imageText, sizeText } from '@/lib/sandbox'
import { tabSearch, useSearchTab } from '@/lib/search'
import { isIdle, isLive } from '@/lib/status'
import { loaderTitle } from '@/lib/title'
import { toneBorder, toneText } from '@/lib/tone'
import { loadTrail, useEnvironmentTrail } from '@/lib/use-trail'

const SandboxTerminal = lazy(() =>
  import('@/components/sandbox-terminal').then((m) => ({
    default: m.SandboxTerminal,
  })),
)

const tabs = ['terminal', 'variables', 'logs', 'snapshots', 'network'] as const

export const Route = createFileRoute('/_app/sandboxes/$sandbox')({
  validateSearch: tabSearch(tabs),
  loader: async ({ context, params }) => {
    const sandbox = await load(context.queryClient, sandboxQuery(params.sandbox))

    return {
      title: [sandbox.name, await loadTrail(context.queryClient, sandbox.environment_id)],
    }
  },
  head: loaderTitle,
  errorComponent: failurePage('Couldn’t load this sandbox'),
  component: SandboxPage,
})

function Snapshots({
  sandbox,
  project,
  environment,
}: {
  sandbox: Sandbox
  project: string
  environment: string
}) {
  const { data } = useSuspenseQuery(sandboxOwnSnapshotsQuery(sandbox.id))

  return (
    <div className="space-y-3">
      <CopiedFilesNotice />
      <SnapshotsTable
        snapshots={data.items}
        project={project}
        environment={environment}
        originLabel="Taken"
        origin={(snapshot) => (
          <span className="text-muted-foreground">{snapshotSource[snapshot.source_state]}</span>
        )}
        empty={
          <EmptyState
            icon={entityIcon.snapshot}
            title="No snapshots yet"
            description="A snapshot saves this sandbox’s disk so you can fork new sandboxes from it."
            action={<SnapshotSandbox sandbox={sandbox} />}
            also={
              <AlsoWith
                cli={commands.snapshotSandbox(
                  {
                    project,
                    environment,
                  },
                  sandbox.name,
                )}
                tool="snapshot_sandbox"
              />
            }
          />
        }
      />
    </div>
  )
}

function Overview({ sandbox }: { sandbox: Sandbox }) {
  const metrics = sandbox.metrics
  const workspaceRow: [string, ReactNode][] = sandbox.workspace
    ? [
        [
          'Workspace',
          <Code key="w" copy={sandbox.workspace.path}>
            {`${sandbox.workspace.agent} in ${sandbox.workspace.path}`}
          </Code>,
        ],
      ]
    : []

  return (
    <KeyValue
      framed
      items={[
        ['Image', <Code key="i">{imageText(sandbox.image)}</Code>],
        ['Size', sizeText(sandbox.size)],
        ['Runtime', sandboxRuntime[sandbox.runtime]],
        ...workspaceRow,
        [
          'Network',
          `${sandbox.network ? sandboxNetwork[sandbox.network] : blank}${sandbox.docker ? ' · Docker inside' : ''}`,
        ],
        ['Outbound traffic', egressText(sandbox.egress)],
        ['Disk', `${bytes(sandbox.disk_used_bytes)} of ${bytes(sandbox.size.disk_bytes)}`],
        ['CPU', metrics ? `${metrics.cpu_pct.toFixed(1)}%` : 'not running'],
        [
          'Memory',
          metrics
            ? `${bytes(metrics.memory_bytes)} of ${bytes(metrics.memory_limit_bytes)}`
            : 'not running',
        ],
        [
          'Address',
          sandbox.address ? (
            <Code key="a" copy={sandbox.address}>
              {sandbox.address}
            </Code>
          ) : (
            'none'
          ),
        ],
      ]}
    />
  )
}

function Actions({
  s,
  project,
  environment,
}: {
  s: Sandbox
  project: string
  environment: string
}) {
  const navigate = useNavigate()

  return (
    <>
      {isIdle(s.status) ? (
        <StartSandbox sandbox={s} />
      ) : isLive(s.status) ? (
        <StopSandbox sandbox={s} />
      ) : null}
      <ExtendSandbox sandbox={s} />
      <SnapshotSandbox sandbox={s} />
      <ForkButton
        source={{
          kind: 'sandbox',
          sandbox: s,
        }}
        project={project}
        environment={environment}
      />
      <DeleteSandbox
        sandbox={s}
        after={() =>
          void navigate({
            to: '/projects/$project/$environment',
            params: {
              project,
              environment,
            },
            search: {
              tab: s.workspace ? 'workspaces' : 'sandboxes',
            },
          })
        }
      />
    </>
  )
}

function Failure({ s }: { s: Sandbox }) {
  return (
    s.failure && (
      <Alert className={toneBorder.danger}>
        <CircleAlert className={toneText.danger} />
        <AlertTitle className="font-medium">{s.name} failed</AlertTitle>
        <AlertDescription className="space-y-1 [&_p:not(:last-child)]:mb-0">
          <p className="text-foreground">{s.failure.summary}</p>
          <p className="font-mono text-xs text-muted-foreground">{s.failure.code}</p>
        </AlertDescription>
      </Alert>
    )
  )
}

function MachineTabs({
  s,
  project,
  environment,
}: {
  s: Sandbox
  project: string
  environment: string
}) {
  const { tab } = Route.useSearch()
  const selectTab = useSearchTab(tabs)

  return (
    <Tabs value={tab} onValueChange={selectTab}>
      <TabsList>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
        <TabsTrigger value="variables">Variables</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
        <TabsTrigger value="network">Network</TabsTrigger>
      </TabsList>
      <TabsContent value="terminal" className="mt-4">
        <Panel rows={4} title="Couldn’t open the terminal">
          <SandboxTerminal sandbox={s} />
        </Panel>
      </TabsContent>
      <TabsContent value="variables" className="mt-4">
        <VariablesPanel
          target={{
            kind: 'sandbox',
            sandbox: s.id,
          }}
          also={<AlsoWith cli={commands.setSandboxVariable(s.id)} tool="set_sandbox_variables" />}
        />
      </TabsContent>
      <TabsContent value="logs" className="mt-4">
        <Section
          title="Startup log"
          description="What the sandbox’s startup process printed since its last start."
        >
          <Panel title="Couldn’t load the startup log">
            <LogViewer
              key={`${s.id}-${s.status === 'running'}`}
              selector={{
                sandbox: s.id,
                role: 'init',
              }}
              follow={s.status === 'running'}
              label="Sandbox startup log"
            />
          </Panel>
        </Section>
      </TabsContent>
      <TabsContent value="snapshots" className="mt-4">
        <Panel rows={2} title="Couldn’t load snapshots">
          <Snapshots sandbox={s} project={project} environment={environment} />
        </Panel>
      </TabsContent>
      <TabsContent value="network" className="mt-4">
        <SandboxNetwork sandbox={s} />
      </TabsContent>
    </Tabs>
  )
}

function Machine({
  s,
  project,
  environment,
}: {
  s: Sandbox
  project: string
  environment: string
}) {
  return (
    <div className="space-y-6">
      <Overview sandbox={s} />
      <MachineTabs s={s} project={project} environment={environment} />
    </div>
  )
}

function WorkspaceHeader({
  s,
  trail,
}: {
  s: Sandbox
  trail: ReturnType<typeof useEnvironmentTrail>
}) {
  const [managing, setManaging] = useState(false)
  const shell = commands.openWorkspace(
    {
      project: trail.project.name,
      environment: trail.environment.name,
    },
    s.name,
  )

  return (
    <div>
      <Crumbs
        items={[
          ...trail.crumbs,
          {
            label: s.name,
          },
        ]}
      />
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <entityIcon.workspace className="size-5 text-muted-foreground" aria-hidden />
            {s.name}
          </span>
        }
        meta={
          <>
            <AgentStatusBadge status={s.agent_status} announce />
            <SandboxStatusBadge status={s.status} reason={s.status_reason} />
            {s.workspace && (
              <span className="font-mono text-xs">{repositoryName(s.workspace.repository)}</span>
            )}
            {s.workspace?.branch && <Code copy={s.workspace.branch}>{s.workspace.branch}</Code>}
            {s.workspace && <span>{agentLabel(s.workspace.agent)}</span>}
          </>
        }
        actions={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Workspace actions"
            aria-expanded={managing}
            onClick={() => setManaging((open) => !open)}
          >
            <Ellipsis />
          </Button>
        }
      >
        <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          Open a terminal on it
          <Code copy={shell}>{shell}</Code>
        </p>
      </PageHeader>
      {managing && (
        <div className="flex flex-wrap items-center gap-2 border-b py-3">
          <Actions s={s} project={trail.project.name} environment={trail.environment.name} />
        </div>
      )}
    </div>
  )
}

function WorkspacePage({ s, admin }: { s: Sandbox; admin: boolean }) {
  const trail = useEnvironmentTrail(s.environment_id)

  return (
    <div className="space-y-6">
      <WorkspaceHeader s={s} trail={trail} />
      <ProtectedNotice environment={trail.environment} />
      <Failure s={s} />
      {admin && <WorkspaceSessions sandbox={s} />}
      {admin ? (
        <Collapsible className="group/machine">
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRight
              className="size-4 text-muted-foreground transition-transform group-data-[state=open]/machine:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            Machine
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            <Machine s={s} project={trail.project.name} environment={trail.environment.name} />
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <Machine s={s} project={trail.project.name} environment={trail.environment.name} />
      )}
    </div>
  )
}

function PlainSandboxPage({ s }: { s: Sandbox }) {
  const trail = useEnvironmentTrail(s.environment_id)

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            ...trail.crumbs,
            {
              label: s.name,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              <entityIcon.sandbox className="size-5 text-muted-foreground" aria-hidden />
              {s.name}
            </span>
          }
          meta={
            <>
              <SandboxStatusBadge status={s.status} reason={s.status_reason} />
              <span data-testid="sandbox-time">
                <TimeLeft sandbox={s} />
              </span>
              {s.forked_from && <span>Fork</span>}
              <Code copy={s.id} className="text-muted-foreground">
                {s.id}
              </Code>
            </>
          }
          actions={
            <Actions s={s} project={trail.project.name} environment={trail.environment.name} />
          }
        />
      </div>
      <ProtectedNotice environment={trail.environment} />
      <Failure s={s} />
      <Machine s={s} project={trail.project.name} environment={trail.environment.name} />
    </div>
  )
}

function SandboxPage() {
  const { sandbox: id } = Route.useParams()
  const { data: s } = useSuspenseQuery(sandboxQuery(id))
  const { data: me } = useQuery(meQuery)

  return s.workspace ? (
    <WorkspacePage s={s} admin={isInstanceAdmin(me?.scopes ?? [])} />
  ) : (
    <PlainSandboxPage s={s} />
  )
}
