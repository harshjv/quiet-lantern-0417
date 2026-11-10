import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleAlert, TerminalSquare } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Crumbs } from '@/components/crumbs'
import { LogViewer } from '@/components/log-viewer'
import { Empty, KeyValue, Mono, PageHeader, Rows, Section } from '@/components/page'
import { QueryState } from '@/components/query-state'
import { SnapshotsTable } from '@/components/snapshots-table'
import { CopiedFilesNotice, DeleteSandbox, ExtendSandbox, ForkButton, SnapshotSandbox, StartSandbox, StopSandbox } from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { SandboxNetwork } from '@/components/sandbox-network'
import { ProtectedNotice } from '@/components/sandboxes-panel'
import { SandboxStatusBadge } from '@/components/status'
import { VariablesPanel } from '@/components/variables-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { bytes } from '@/lib/format'
import { sandboxOwnSnapshotsQuery, sandboxQuery } from '@/lib/queries'
import { egressText, imageText, sizeText } from '@/lib/sandbox'
import { useEnvironmentTrail } from '@/lib/use-trail'
import { isIdle, isLive } from '@/lib/status'
import type { Sandbox } from '@/lib/api'

const SandboxTerminal = lazy(() => import('@/components/sandbox-terminal').then(m => ({ default: m.SandboxTerminal })))

const tabs = ['terminal', 'variables', 'logs', 'snapshots', 'network'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/sandboxes/$sandbox')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => (tabs.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {}),
  component: SandboxPage
})

function Snapshots({ sandbox, project, environment }: { sandbox: Sandbox; project: string; environment: string }) {
  const snapshots = useQuery(sandboxOwnSnapshotsQuery(sandbox.id))
  return (
    <div className="space-y-3">
      <CopiedFilesNotice />
      <SnapshotsTable
        query={snapshots}
        project={project}
        environment={environment}
        originLabel="Source"
        origin={snapshot => <span className="text-muted-foreground">{snapshot.source_state}</span>}
        empty={<Empty title="No snapshots of this sandbox">Take one with Snapshot above, with sly sandbox snapshot, or with the snapshot_sandbox MCP tool.</Empty>}
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
        ['Image', <Mono key="i">{imageText(sandbox.image)}</Mono>],
        ['Size', sizeText(sandbox.size)],
        ['Network', `${sandbox.network}${sandbox.docker ? ' · docker' : ''}`],
        ['Egress', egressText(sandbox.egress)],
        ['Disk', `${bytes(sandbox.disk_used_bytes)} of ${bytes(sandbox.size.disk_bytes)}`],
        ['CPU', metrics ? `${metrics.cpu_pct.toFixed(1)}%` : '—'],
        ['Memory', metrics ? `${bytes(metrics.memory_bytes)} of ${bytes(metrics.memory_limit_bytes)}` : '—'],
        ['Address', sandbox.address ? <Mono key="a">{sandbox.address}</Mono> : '—']
      ]}
    />
  )
}

function SandboxPage() {
  const { sandbox: id } = Route.useParams()
  const sandbox = useQuery(sandboxQuery(id))
  return (
    <QueryState query={sandbox} rows={6} errorTitle="The sandbox could not be loaded">
      {s => <SandboxView s={s} />}
    </QueryState>
  )
}

function SandboxView({ s }: { s: Sandbox }) {
  const { tab = 'terminal' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const trail = useEnvironmentTrail(s.environment_id)
  const projectName = trail.project?.name
  const environmentName = trail.environment?.name

  return (
    <div className="space-y-6">
      <div>
        <Crumbs items={[...trail.crumbs, { label: s.name }]} />
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
              {s.forked_from && <span>forked</span>}
              <Mono className="text-muted-foreground">{s.id}</Mono>
            </>
          }
          actions={
            <>
              {isIdle(s.status) ? <StartSandbox sandbox={s} /> : isLive(s.status) ? <StopSandbox sandbox={s} /> : null}
              <ExtendSandbox sandbox={s} />
              <SnapshotSandbox sandbox={s} />
              {projectName && environmentName && <ForkButton source={{ kind: 'sandbox', sandbox: s }} project={projectName} environment={environmentName} />}
              <DeleteSandbox sandbox={s} after={() => void navigate({ to: '/projects/$project/$environment', params: { project: projectName ?? '', environment: environmentName ?? '' }, search: { tab: 'sandboxes' } })} />
            </>
          }
        />
      </div>
      {trail.environment && <ProtectedNotice environment={trail.environment} />}
      {s.failure && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{s.failure.code}</AlertTitle>
          <AlertDescription className="text-foreground">{s.failure.summary}</AlertDescription>
        </Alert>
      )}
      <Overview sandbox={s} />
      <Tabs value={tab} onValueChange={value => void navigate({ search: { tab: value as Tab }, replace: true })}>
        <TabsList>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
        </TabsList>
        <TabsContent value="terminal" className="mt-4">
          <Suspense fallback={<Rows count={4} />}>
            <SandboxTerminal sandbox={s} />
          </Suspense>
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel target={{ kind: 'sandbox', sandbox: s.id }} />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <Section title="Init log" description="What the sandbox's init process printed since its last start.">
            <LogViewer key={`${s.id}-${s.status === 'running'}`} selector={{ sandbox: s.id, role: 'init' }} follow={s.status === 'running'} label="Sandbox init log" />
          </Section>
        </TabsContent>
        <TabsContent value="snapshots" className="mt-4">
          {projectName && environmentName ? <Snapshots sandbox={s} project={projectName} environment={environmentName} /> : <Rows count={2} />}
        </TabsContent>
        <TabsContent value="network" className="mt-4">
          <SandboxNetwork sandbox={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
