import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Check, CircleDashed, Loader2, Square, TriangleAlert, X } from 'lucide-react'
import { useRef } from 'react'

import { Trigger } from '@/components/actor'
import { DiagnosisPanel } from '@/components/diagnosis'
import { Disclosure } from '@/components/disclosure'
import { FirstLive } from '@/components/first-live'
import { LogViewer } from '@/components/log-viewer'
import { KeyValue, Mono } from '@/components/page'
import { Panel } from '@/components/panel'
import { DeploymentStatusBadge } from '@/components/status'
import { Time, useNow } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, idempotency, send, type Deployment, type DeploymentStep } from '@/lib/api'
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
  appQuery,
  deploymentQuery,
  deploymentsQuery,
  diagnosisQuery,
  seedDeployment,
} from '@/lib/queries'
import { isCancellable, isTerminal, stepProgress } from '@/lib/status'
import { toneText, toneWash } from '@/lib/tone'
import { useBecame, useMoment } from '@/lib/use-moment'
import { useTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

import { Page, PageBoundary, Section } from './parts'

export function DeploymentPage({ deploymentId }: { deploymentId: string }) {
  return (
    <PageBoundary title="Couldn’t load this deployment" resetKey={deploymentId}>
      <DeploymentView id={deploymentId} />
    </PageBoundary>
  )
}

function DeploymentView({ id }: { id: string }) {
  const { data: d } = useSuspenseQuery(deploymentQuery(id))
  const { data: app } = useSuspenseQuery(appQuery(d.app_id))
  const trail = useTrail(app)
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
  const history = useQuery(deploymentsQuery(app.id))
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
    <div ref={page}>
      <Page
        title={`${app.name} #${d.number}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {isCancellable(d.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? <Loader2 className="animate-spin" /> : <X />}
                Cancel deployment
              </Button>
            )}
            {d.status === 'failed' && (
              <Button asChild size="sm">
                <Link
                  to="/build/new"
                  search={{
                    fix: `deployment:${d.id}`,
                  }}
                >
                  <TriangleAlert /> Fix with an agent
                </Link>
              </Button>
            )}
          </span>
        }
      >
        <div className="-mt-4 flex flex-col gap-2">
          <Link
            to="/apps/$app/{-$tab}"
            params={{
              app: app.id,
            }}
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {app.name} in {trail.project.name} / {trail.place.previewName ?? 'production'}
          </Link>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <DeploymentStatusBadge status={d.status} />
            <Mono>{d.id}</Mono>
            <Time value={d.started_at ?? d.created_at} />
            {live && <StepHeader steps={steps} />}
          </p>
        </div>
        {firstLive && <FirstLive app={app} />}
        <Facts deployment={d} />
        {d.status === 'failed' && (
          <Panel title="Couldn’t load the diagnosis">
            <Diagnosis
              deployment={d.id}
              build={d.build?.id ?? null}
              context={{
                ...trail.scope,
                subject: {
                  kind: 'app',
                  id: app.id,
                  name: app.name,
                },
                server: app.server_id ?? undefined,
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
        <Section title="Logs" note="Stationly hides known secret values in these logs.">
          <Logs deployment={d} live={live} />
        </Section>
      </Page>
    </div>
  )
}

function Facts({ deployment: d }: { deployment: Deployment }) {
  return (
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
        ['Image', d.image_ref ? <Mono key="image">{shortDigest(d.image_ref)}</Mono> : 'none'],
        [
          'Build',
          d.build
            ? `${builder[d.build.builder]} build, ${d.build.duration_s ? span(d.build.duration_s) : buildStatus[d.build.status].toLowerCase()}`
            : 'none',
        ],
      ]}
    >
      {d.cancel_reason && (
        <p className="text-sm text-muted-foreground">{cancelReason[d.cancel_reason]}.</p>
      )}
    </KeyValue>
  )
}

function Logs({ deployment: d, live }: { deployment: Deployment; live: boolean }) {
  return (
    <Panel title="Couldn’t load logs">
      <Tabs
        defaultValue={
          d.build && (d.status === 'building' || d.build.status === 'failed') ? 'build' : 'runtime'
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
  )
}

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
    <ol className="relative overflow-hidden border" aria-label="Deployment steps">
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
          <span className="ml-auto flex gap-3 font-mono text-xs text-muted-foreground tabular-nums">
            <span>{clock(step.started_at)}</span>
            {step.started_at && <span>{duration(step.started_at, step.finished_at)}</span>}
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
