import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleAlert, TerminalSquare } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Crumbs } from '@/components/crumbs'
import { LogViewer } from '@/components/log-viewer'
import { Empty, ErrorState, KeyValue, Mono, PageHeader, Rows, Section } from '@/components/page'
import { CopiedFilesNotice, DeleteSandbox, DeleteSnapshot, ExtendSandbox, ForkButton, SnapshotSandbox, StartSandbox, StopSandbox } from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { SandboxNetwork } from '@/components/sandbox-network'
import { ProtectedNotice } from '@/components/sandboxes-panel'
import { SandboxStatusBadge } from '@/components/status'
import { VariablesPanel } from '@/components/variables-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ago, bytes } from '@/lib/format'
import { environmentQuery, projectQuery, sandboxOwnSnapshotsQuery, sandboxQuery } from '@/lib/queries'
import { imageText, sizeText } from '@/lib/sandbox'
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
      {snapshots.isPending ? (
        <Rows count={2} />
      ) : snapshots.isError ? (
        <ErrorState error={snapshots.error} />
      ) : snapshots.data.items.length === 0 ? (
        <Empty title="No snapshots of this sandbox">Take one with Snapshot above, with sly sandbox snapshot, or with the snapshot_sandbox MCP tool.</Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Snapshot</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden sm:table-cell">Source</TableHead>
                <TableHead className="hidden md:table-cell">Size</TableHead>
                <TableHead>Taken</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.data.items.map(snapshot => (
                <TableRow key={snapshot.id}>
                  <TableCell>
                    <Mono className="font-medium">{snapshot.name ?? snapshot.id}</Mono>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{snapshot.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{snapshot.source_state}</TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">{bytes(snapshot.referenced_bytes)}</TableCell>
                  <TableCell className="text-muted-foreground">{ago(snapshot.taken_at)}</TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-1">
                      {snapshot.status === 'ready' && <ForkButton source={{ kind: 'snapshot', snapshot }} project={project} environment={environment} iconOnly />}
                      <DeleteSnapshot snapshot={snapshot} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function Overview({ sandbox }: { sandbox: Sandbox }) {
  const metrics = sandbox.metrics
  return (
    <div className="rounded-lg border bg-card p-4">
      <KeyValue
        items={[
          ['Image', <Mono key="i">{imageText(sandbox.image)}</Mono>],
          ['Size', sizeText(sandbox.size)],
          ['Network', `${sandbox.network}${sandbox.docker ? ' · docker' : ''}`],
          ['Egress', sandbox.egress.mode === 'open' ? 'open' : `allowlist, ${sandbox.egress.domains?.length ?? 0} domains`],
          ['Disk', `${bytes(sandbox.disk_used_bytes)} of ${bytes(sandbox.size.disk_bytes)}`],
          ['CPU', metrics ? `${metrics.cpu_pct.toFixed(1)}%` : '—'],
          ['Memory', metrics ? `${bytes(metrics.memory_bytes)} of ${bytes(metrics.memory_limit_bytes)}` : '—'],
          ['Address', sandbox.address ? <Mono key="a">{sandbox.address}</Mono> : '—']
        ]}
      />
    </div>
  )
}

function SandboxPage() {
  const { sandbox: id } = Route.useParams()
  const { tab = 'terminal' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const sandbox = useQuery(sandboxQuery(id))
  const environment = useQuery({ ...environmentQuery(sandbox.data?.environment_id ?? ''), enabled: Boolean(sandbox.data) })
  const project = useQuery({ ...projectQuery(environment.data?.project_id ?? ''), enabled: Boolean(environment.data) })

  if (sandbox.isPending) return <Rows count={6} />
  if (sandbox.isError) return <ErrorState error={sandbox.error} title="The sandbox could not be loaded" />
  const s = sandbox.data
  const idle = s.status === 'stopped' || s.status === 'failed'
  const live = s.status === 'running' || s.status === 'starting' || s.status === 'creating'
  const projectName = project.data?.name
  const environmentName = environment.data?.name

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            { label: 'Projects', to: '/' },
            ...(projectName && environmentName
              ? [
                  { label: projectName, to: '/projects/$project', params: { project: projectName } },
                  { label: environmentName, to: '/projects/$project/$environment', params: { project: projectName, environment: environmentName } }
                ]
              : []),
            { label: s.name }
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
              {s.forked_from && <span>forked</span>}
              <Mono className="text-muted-foreground">{s.id}</Mono>
            </>
          }
          actions={
            <>
              {idle ? <StartSandbox sandbox={s} /> : live ? <StopSandbox sandbox={s} /> : null}
              <ExtendSandbox sandbox={s} />
              <SnapshotSandbox sandbox={s} />
              {projectName && environmentName && <ForkButton source={{ kind: 'sandbox', sandbox: s }} project={projectName} environment={environmentName} />}
              <DeleteSandbox sandbox={s} after={() => void navigate({ to: '/projects/$project/$environment', params: { project: projectName ?? '', environment: environmentName ?? '' }, search: { tab: 'sandboxes' } })} />
            </>
          }
        />
      </div>
      {environment.data && <ProtectedNotice environment={environment.data} />}
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
