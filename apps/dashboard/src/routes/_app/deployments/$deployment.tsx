import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, CircleDashed, Loader2, Square, X } from 'lucide-react'
import { useRef } from 'react'

import { Trigger } from '@/components/actor'
import { Crumbs } from '@/components/crumbs'
import { DiagnosisPanel } from '@/components/diagnosis'
import { Disclosure } from '@/components/disclosure'
import { FirstLive } from '@/components/first-live'
import { LogViewer } from '@/components/log-viewer'
import { KeyValue, Mono, PageHeader, Section } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { DeploymentStatusBadge } from '@/components/status'
import { Time, useNow } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, idempotency, send, type DeploymentStep } from '@/lib/api'
import type { FixContext } from '@/lib/fixes'
import { clock, duration, plural, shortDigest, shortSha, span, stamp } from '@/lib/format'
import {
  builder,
  buildStatus,
  cancelReason,
  deploymentStep,
  deploymentStrategy,
  stepStatus,
} from '@/lib/labels'
import { isFirstLive } from '@/lib/moments'
import { useApiMutation } from '@/lib/mutation'
import {
  deploymentQuery,
  deploymentsQuery,
  diagnosisQuery,
  load,
  seedDeployment,
  serviceQuery,
  warm,
} from '@/lib/queries'
import { isCancellable, isTerminal, stepProgress } from '@/lib/status'
import { loaderTitle } from '@/lib/title'
import { toneText, toneWash } from '@/lib/tone'
import { useBecame, useMoment } from '@/lib/use-moment'
import { loadTrail, useEnvironmentTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/deployments/$deployment')({
  loader: async ({ context, params }) => {
    const deployment = await load(context.queryClient, deploymentQuery(params.deployment))
    const [service] = await Promise.all([
      load(context.queryClient, serviceQuery(deployment.service_id)),
      deployment.status === 'failed' && warm(context.queryClient, diagnosisQuery(deployment.id)),
    ])

    return {
      title: [
        `${service.name} #${deployment.number}`,
        await loadTrail(context.queryClient, service.environment_id),
      ],
    }
  },
  head: loaderTitle,
  errorComponent: failurePage('Couldn’t load this deployment'),
  component: DeploymentPage,
})

function Diagnosis({
  deployment,
  build,
  context,
}: {
  deployment: string
  build: string | null
  context: FixContext
}) {
  const { data } = useSuspenseQuery(diagnosisQuery(deployment))

  return (
    <DiagnosisPanel
      diagnosis={data}
      context={{
        ...context,
        deployment: {
          id: deployment,
          build: data.phase === 'build' ? build : null,
        },
      }}
    />
  )
}

function StepIcon({ status }: { status: DeploymentStep['status'] }) {
  if (status === 'done') {
    return <Check className={cn('size-3.5', toneText.success)} aria-hidden />
  }

  if (status === 'failed') {
    return <X className={cn('size-3.5', toneText.danger)} aria-hidden />
  }

  if (status === 'running') {
    return (
      <Loader2
        className={cn('size-3.5 animate-spin motion-reduce:animate-none', toneText.info)}
        aria-hidden
      />
    )
  }

  if (status === 'skipped') {
    return <Square className="size-3 text-muted-foreground" aria-hidden />
  }

  return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
}

function Steps({ steps }: { steps: DeploymentStep[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-muted-foreground">No step has started yet.</p>
  }

  return (
    <ol
      className="relative space-y-0 overflow-hidden rounded-lg border"
      aria-label="Deployment steps"
    >
      {steps.map((step) => (
        <li
          key={step.id}
          className={cn(
            'flex items-center gap-3 border-b bg-card px-4 py-2 text-sm last:border-b-0',
            step.status === 'failed' && toneWash.danger,
          )}
        >
          <StepIcon status={step.status} />
          <span className="font-medium">{deploymentStep[step.step]}</span>
          {step.attempt > 1 && (
            <span className="text-xs text-muted-foreground">Attempt {step.attempt}</span>
          )}
          <span className="text-muted-foreground">{stepStatus[step.status]}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
            {clock(step.started_at)}
            {step.started_at && ` · ${duration(step.started_at, step.finished_at)}`}
          </span>
        </li>
      ))}
    </ol>
  )
}

function StepHeader({ steps }: { steps: DeploymentStep[] }) {
  const now = useNow(1000)
  const text = stepProgress(steps, new Date(now))

  return text && <span className="text-foreground tabular-nums">{text}</span>
}

function DeploymentPage() {
  const { deployment: id } = Route.useParams()
  const { data: d } = useSuspenseQuery(deploymentQuery(id))
  const { data: service } = useSuspenseQuery(serviceQuery(d.service_id))
  const trail = useEnvironmentTrail(service.environment_id)
  const cancel = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .deployments({
            id: d.id,
          })
          .cancel.post(undefined, idempotency()),
      ),
    seed: seedDeployment,
    invalidate: ['deployments'],
    success: () => `Deployment #${d.number} cancelled`,
    failure: () => `cancel deployment #${d.number}`,
  })
  const live = !isTerminal(d.status)
  const history = useQuery(deploymentsQuery(service.id))
  const became = useBecame(d.id, d.status === 'active')
  const firstLive = became && history.data !== undefined && isFirstLive(d.id, history.data.items)
  const page = useRef<HTMLDivElement>(null)

  useMoment(page, firstLive, (timeline) =>
    timeline
      .from('[data-moment="live"]', {
        autoAlpha: 0,
        y: 8,
      })
      .from('[data-moment="address"]', {
        autoAlpha: 0,
        x: -8,
      })
      .from(
        '[data-moment="steps"]',
        {
          autoAlpha: 0,
        },
        '<',
      ),
  )
  const steps = d.steps ?? []

  return (
    <div ref={page} className="space-y-6">
      <div>
        <Crumbs
          items={[
            ...trail.crumbs,
            {
              label: service.name,
              to: '/services/$service',
              params: {
                service: service.id,
              },
            },
            {
              label: `#${d.number}`,
            },
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
              <Link
                to="/services/$service"
                params={{
                  service: service.id,
                }}
                className="underline-offset-4 hover:underline"
              >
                {service.name}
              </Link>
              <Mono>{d.id}</Mono>
              <Time value={d.started_at ?? d.created_at} />
              {live && <StepHeader steps={steps} />}
            </>
          }
          actions={
            isCancellable(d.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? <Loader2 className="animate-spin" /> : <X />}
                Cancel deployment
              </Button>
            )
          }
        />
      </div>
      {firstLive && <FirstLive service={service} />}
      <KeyValue
        framed
        items={[
          ['Trigger', <Trigger key="trigger" trigger={d.trigger} />],
          [
            'Commit',
            d.trigger.source_sha ? <Mono key="sha">{shortSha(d.trigger.source_sha)}</Mono> : 'none',
          ],
          ['Strategy', deploymentStrategy[d.strategy]],
          ['Duration', duration(d.started_at, d.finished_at)],
          ['Started', stamp(d.started_at)],
          ['Finished', stamp(d.finished_at)],
          ['Image', d.image_ref ? <Mono key="img">{shortDigest(d.image_ref)}</Mono> : 'none'],
          [
            'Build',
            d.build
              ? `${builder[d.build.builder]} build · ${d.build.duration_s ? span(d.build.duration_s) : buildStatus[d.build.status]}`
              : 'none',
          ],
        ]}
      >
        {d.cancel_reason && (
          <p className="mt-3 text-sm text-muted-foreground">{cancelReason[d.cancel_reason]}.</p>
        )}
      </KeyValue>
      {d.status === 'failed' && (
        <Panel title="Couldn’t load the diagnosis">
          <Diagnosis
            deployment={d.id}
            build={d.build?.id ?? null}
            context={{
              project: trail.project.name,
              environment: trail.environment.name,
              subject: {
                kind: 'service',
                id: service.id,
                name: service.name,
              },
              station: service.station_id ?? undefined,
            }}
          />
        </Panel>
      )}
      <Section title="Steps">
        {firstLive ? (
          <div data-moment="steps">
            <Disclosure
              title={`Live in ${duration(d.started_at, d.finished_at)}`}
              summary={plural(steps.length, 'step')}
            >
              <Steps steps={steps} />
            </Disclosure>
          </div>
        ) : (
          <Steps steps={steps} />
        )}
      </Section>
      <Section title="Logs" description="Stationly hides known secret values in these logs.">
        <Panel title="Couldn’t load logs">
          <Tabs
            defaultValue={
              d.build && (d.status === 'building' || d.build.status === 'failed')
                ? 'build'
                : 'runtime'
            }
          >
            <TabsList>
              <TabsTrigger value="runtime">Runtime</TabsTrigger>
              {d.build && <TabsTrigger value="build">Build</TabsTrigger>}
            </TabsList>
            <TabsContent value="runtime" className="mt-3">
              <LogViewer
                key={d.status === 'active' ? 'active' : 'other'}
                selector={{
                  deployment: d.id,
                }}
                follow={live || d.status === 'active'}
                label="Runtime logs"
              />
            </TabsContent>
            {d.build && (
              <TabsContent value="build" className="mt-3">
                <LogViewer
                  selector={{
                    build: d.build.id,
                  }}
                  follow={d.status === 'building'}
                  label="Build logs"
                />
              </TabsContent>
            )}
          </Tabs>
        </Panel>
      </Section>
    </div>
  )
}
