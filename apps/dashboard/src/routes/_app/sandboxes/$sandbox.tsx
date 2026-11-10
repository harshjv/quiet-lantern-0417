import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Camera, CircleAlert, TerminalSquare } from 'lucide-react'
import { lazy } from 'react'

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import type { Sandbox } from '@/lib/api'
import { commands } from '@/lib/commands'
import { blank, bytes } from '@/lib/format'
import { sandboxNetwork, snapshotSource } from '@/lib/labels'
import { load, sandboxOwnSnapshotsQuery, sandboxQuery } from '@/lib/queries'
import { egressText, imageText, sizeText } from '@/lib/sandbox'
import { isIdle, isLive } from '@/lib/status'
import { loadTrail, useEnvironmentTrail } from '@/lib/use-trail'

const SandboxTerminal = lazy(() =>
  import('@/components/sandbox-terminal').then((m) => ({
    default: m.SandboxTerminal,
  })),
)

const tabs = ['terminal', 'variables', 'logs', 'snapshots', 'network'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/sandboxes/$sandbox')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab)
      ? {
          tab: search.tab as Tab,
        }
      : {},
  loader: async ({ context, params }) => {
    const sandbox = await load(context.queryClient, sandboxQuery(params.sandbox))
    await loadTrail(context.queryClient, sandbox.environment_id)
  },
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
            icon={Camera}
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
  return (
    <KeyValue
      framed
      items={[
        ['Image', <Code key="i">{imageText(sandbox.image)}</Code>],
        ['Size', sizeText(sandbox.size)],
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

function SandboxPage() {
  const { sandbox: id } = Route.useParams()
  const { tab = 'terminal' } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })
  const { data: s } = useSuspenseQuery(sandboxQuery(id))
  const trail = useEnvironmentTrail(s.environment_id)
  const projectName = trail.project.name
  const environmentName = trail.environment.name

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
              <TerminalSquare className="size-5 text-muted-foreground" aria-hidden />
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
                project={projectName}
                environment={environmentName}
              />
              <DeleteSandbox
                sandbox={s}
                after={() =>
                  void navigate({
                    to: '/projects/$project/$environment',
                    params: {
                      project: projectName,
                      environment: environmentName,
                    },
                    search: {
                      tab: 'sandboxes',
                    },
                  })
                }
              />
            </>
          }
        />
      </div>
      <ProtectedNotice environment={trail.environment} />
      {s.failure && (
        <Alert className="border-red-300 dark:border-red-900">
          <CircleAlert className="text-red-600 dark:text-red-400" />
          <AlertTitle className="font-medium">{s.name} failed</AlertTitle>
          <AlertDescription className="space-y-1 [&_p:not(:last-child)]:mb-0">
            <p className="text-foreground">{s.failure.summary}</p>
            <p className="font-mono text-xs text-muted-foreground">{s.failure.code}</p>
          </AlertDescription>
        </Alert>
      )}
      <Overview sandbox={s} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search: {
              tab: value as Tab,
            },
            replace: true,
          })
        }
      >
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
            <Snapshots sandbox={s} project={projectName} environment={environmentName} />
          </Panel>
        </TabsContent>
        <TabsContent value="network" className="mt-4">
          <SandboxNetwork sandbox={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
