import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Check, CircleDashed, Loader2, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { Crumbs } from '@/components/crumbs'
import { DiagnosisPanel } from '@/components/diagnosis'
import { LogViewer } from '@/components/log-viewer'
import { ErrorState, KeyValue, Mono, PageHeader, Rows, Section } from '@/components/page'
import { DeploymentStatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ApiFailure, idempotency, unwrap } from '@/lib/api'
import { ago, clock, duration, shortDigest, shortSha, stamp } from '@/lib/format'
import { deploymentQuery, diagnosisQuery, environmentQuery, isTerminal, projectQuery, serviceQuery } from '@/lib/queries'
import type { DeploymentStep } from '@/lib/api'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/deployments/$deployment')({
  component: DeploymentPage
})

const cancellable = new Set(['queued', 'building', 'pre_deploy', 'starting', 'waiting_health'])

function StepIcon({ status }: { status: string }) {
  if (status === 'done' || status === 'succeeded' || status === 'passed') return <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
  if (status === 'failed') return <X className="size-3.5 text-red-600 dark:text-red-400" aria-hidden />
  if (status === 'running' || status === 'started') return <Loader2 className="size-3.5 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400" aria-hidden />
  if (status === 'skipped' || status === 'cancelled') return <Square className="size-3 text-muted-foreground" aria-hidden />
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
}

function Steps({ steps }: { steps: DeploymentStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted-foreground">No step has started yet.</p>
  return (
    <ol className="relative space-y-0 overflow-hidden rounded-lg border" aria-label="Deployment steps">
      {steps.map(step => (
        <li key={step.id} className={cn('flex items-center gap-3 border-b bg-card px-4 py-2 text-sm last:border-b-0', step.status === 'failed' && 'bg-red-50/60 dark:bg-red-950/30')}>
          <StepIcon status={step.status} />
          <span className="font-medium">{step.step.replaceAll('_', ' ')}</span>
          {step.attempt > 1 && <span className="text-xs text-muted-foreground">attempt {step.attempt}</span>}
          <span className="text-muted-foreground">{step.status}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
            {clock(step.started_at)}
            {step.started_at && ` · ${duration(step.started_at, step.finished_at)}`}
          </span>
        </li>
      ))}
    </ol>
  )
}

function DeploymentPage() {
  const { deployment: id } = Route.useParams()
  const client = useQueryClient()
  const deployment = useQuery(deploymentQuery(id))
  const failed = deployment.data?.status === 'failed'
  const diagnosis = useQuery({ ...diagnosisQuery(id), enabled: failed })
  const service = useQuery({ ...serviceQuery(deployment.data?.service_id ?? ''), enabled: Boolean(deployment.data) })
  const environment = useQuery({ ...environmentQuery(service.data?.environment_id ?? ''), enabled: Boolean(service.data) })
  const project = useQuery({ ...projectQuery(environment.data?.project_id ?? ''), enabled: Boolean(environment.data) })
  const cancel = useMutation({
    mutationFn: () => unwrap(api.v1.deployments({ id }).cancel.post(undefined, idempotency())),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['deployments'] })
      toast.success('Deployment cancelled')
    },
    onError: failure => toast.error('Cancel was refused', { description: failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : String(failure) })
  })

  if (deployment.isPending) return <Rows count={6} />
  if (deployment.isError) return <ErrorState error={deployment.error} title="The deployment could not be loaded" />
  const d = deployment.data
  const live = !isTerminal(d.status)

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            { label: 'Projects', to: '/' },
            ...(project.data && environment.data
              ? [
                  { label: project.data.name, to: '/projects/$project', params: { project: project.data.name } },
                  { label: environment.data.name, to: '/projects/$project/$environment', params: { project: project.data.name, environment: environment.data.name } }
                ]
              : []),
            ...(service.data ? [{ label: service.data.name, to: '/services/$service', params: { service: service.data.id } }] : []),
            { label: `#${d.number}` }
          ]}
        />
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              Deployment #{d.number}
              <DeploymentStatusBadge status={d.status} />
            </span>
          }
          meta={
            <>
              {service.data && (
                <Link to="/services/$service" params={{ service: service.data.id }} className="underline-offset-4 hover:underline">
                  {service.data.name}
                </Link>
              )}
              <Mono>{d.id}</Mono>
              <span>{ago(d.started_at ?? d.created_at)}</span>
            </>
          }
          actions={
            cancellable.has(d.status) && (
              <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? <Loader2 className="animate-spin" /> : <X />}
                Cancel deployment
              </Button>
            )
          }
        />
      </div>
      <div className="rounded-lg border bg-card p-4">
        <KeyValue
          items={[
            ['Trigger', d.trigger.type],
            ['Commit', d.trigger.source_sha ? <Mono key="sha">{shortSha(d.trigger.source_sha)}</Mono> : '—'],
            ['Strategy', d.strategy],
            ['Duration', duration(d.started_at, d.finished_at)],
            ['Started', stamp(d.started_at)],
            ['Finished', stamp(d.finished_at)],
            ['Image', d.image_ref ? <Mono key="img">{shortDigest(d.image_ref)}</Mono> : '—'],
            ['Build', d.build ? `${d.build.builder} · ${d.build.status}${d.build.duration_s ? ` · ${d.build.duration_s}s` : ''}` : 'none']
          ]}
        />
        {d.cancel_reason && <p className="mt-3 text-sm text-muted-foreground">Cancelled: {d.cancel_reason}</p>}
      </div>
      {failed && (diagnosis.isPending ? <Rows count={3} /> : diagnosis.isError ? <ErrorState error={diagnosis.error} title="The diagnosis could not be loaded" /> : <DiagnosisPanel diagnosis={diagnosis.data} />)}
      <Section title="Steps">
        <Steps steps={d.steps ?? []} />
      </Section>
      <Section title="Logs" description="Known secret values are redacted by Dispatch before they reach this page.">
        <Tabs defaultValue={d.build && (d.status === 'building' || d.build.status === 'failed') ? 'build' : 'runtime'}>
          <TabsList>
            <TabsTrigger value="runtime">Runtime</TabsTrigger>
            {d.build && <TabsTrigger value="build">Build</TabsTrigger>}
          </TabsList>
          <TabsContent value="runtime" className="mt-3">
            <LogViewer key={d.status === 'active' ? 'active' : 'other'} selector={{ deployment: d.id }} follow={live || d.status === 'active'} label="Runtime logs" />
          </TabsContent>
          {d.build && (
            <TabsContent value="build" className="mt-3">
              <LogViewer selector={{ build: d.build.id }} follow={d.status === 'building'} label="Build logs" />
            </TabsContent>
          )}
        </Tabs>
      </Section>
    </div>
  )
}
