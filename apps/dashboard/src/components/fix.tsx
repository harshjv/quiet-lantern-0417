import { useNavigate } from '@tanstack/react-router'
import { Loader2, Wrench } from 'lucide-react'

import { Code, Command } from '@/components/code'
import { CopyButton } from '@/components/copy'
import { deployCopy, useDeploy, useRollback } from '@/components/deploy-actions'
import { useSandboxPower } from '@/components/sandbox-actions'
import { Button } from '@/components/ui/button'
import { api, idempotency, send, type ApiFailure } from '@/lib/api'
import { errorFix, planFix, type Fix, type FixContext, type FixPlan, type Run } from '@/lib/fixes'
import { entityIcon } from '@/lib/icons'
import { useApiMutation } from '@/lib/mutation'
import { cn } from '@/lib/utils'

type Pressable = {
  label: string
  primary: boolean
}

function FixButton({
  label,
  primary,
  pending,
  onClick,
}: Pressable & { pending: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={primary ? 'default' : 'outline'}
      onClick={onClick}
      disabled={pending}
    >
      {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Wrench />}
      {label}
    </Button>
  )
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1)

type RunOf<T extends Run['tool']> = Extract<Run, { tool: T }>

function DeployRun({ run, ...props }: Pressable & { run: RunOf<'deploy'> }) {
  const mutation = useDeploy(
    {
      service: run.service,
      trigger: 'manual',
    },
    () => deployCopy(run.name),
    () =>
      send(
        api.v1
          .services({
            service: run.service,
          })
          .deployments.post({}, idempotency()),
      ),
  )

  return <FixButton {...props} pending={mutation.isPending} onClick={() => mutation.mutate()} />
}

function RollbackRun({ run, ...props }: Pressable & { run: RunOf<'rollback'> }) {
  const { mutation, confirm } = useRollback(
    {
      id: run.service,
      name: run.name,
    },
    {
      id: run.deployment,
      label: 'the last good deployment',
    },
  )

  return (
    <>
      <FixButton {...props} pending={mutation.isPending} onClick={() => mutation.mutate(false)} />
      {confirm}
    </>
  )
}

const serviceCopy = {
  start_service: (name: string) => `${name} is starting`,
  update_service: (name: string) => `${name} updated`,
} as const

function ServiceRun({
  run,
  ...props
}: Pressable & { run: RunOf<'start_service' | 'update_service'> }) {
  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: () => {
      const target = api.v1.services({
        service: run.service,
      })

      return send(
        run.tool === 'start_service'
          ? target.start.post(undefined, idempotency())
          : target.patch(run.body, idempotency()),
      )
    },
    invalidate: ['services', 'deployments', 'networking'],
    staged: () => props.label,
    success: (body) => ({
      title: serviceCopy[run.tool](run.name),
      description: body.deployments[0]
        ? `Deployment #${body.deployments[0].number} is rolling it out.`
        : undefined,
    }),
    onSuccess: (result) => {
      const deployment = !result.staged && result.body.deployments[0]

      if (deployment) {
        void navigate({
          to: '/deployments/$deployment',
          params: {
            deployment: deployment.id,
          },
        })
      }
    },
    failure: () => lower(props.label),
  })

  return <FixButton {...props} pending={mutation.isPending} onClick={() => mutation.mutate()} />
}

function SandboxRun({ run, ...props }: Pressable & { run: RunOf<'start_sandbox'> }) {
  const mutation = useSandboxPower(
    {
      id: run.sandbox,
      name: run.name,
    },
    'start',
  )

  return <FixButton {...props} pending={mutation.isPending} onClick={() => mutation.mutate()} />
}

function RunButton({ run, ...props }: Pressable & { run: Run }) {
  if (run.tool === 'deploy') {
    return <DeployRun {...props} run={run} />
  }

  if (run.tool === 'rollback') {
    return <RollbackRun {...props} run={run} />
  }

  if (run.tool === 'start_sandbox') {
    return <SandboxRun {...props} run={run} />
  }

  return <ServiceRun {...props} run={run} />
}

function AskAgent({ plan }: { plan: FixPlan }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
      <entityIcon.agent className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-foreground">Ask your agent</span>{' '}
        <q className="[quotes:'“'_'”']">{plan.prompt}</q>
        {plan.tool && (
          <>
            {' '}
            <span className="whitespace-nowrap">
              with <Code className="text-xs">{plan.tool}</Code>
            </span>
          </>
        )}
      </p>
      <CopyButton value={plan.prompt} label="prompt" className="-mt-1 shrink-0" />
    </div>
  )
}

export function FixActions({ plan, primary }: { plan: FixPlan; primary: boolean }) {
  return (
    <div className="space-y-2">
      {(plan.button || plan.command) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {plan.button && <RunButton {...plan.button} primary={primary} />}
          {plan.command && (
            <span className="inline-flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {plan.button ? 'or run' : 'Run'}
              <Command command={plan.command} className="text-xs" />
            </span>
          )}
        </div>
      )}
      <AskAgent plan={plan} />
    </div>
  )
}

function FixItem({ plan, lead, primary }: { plan: FixPlan; lead: boolean; primary: boolean }) {
  return (
    <li
      className={cn(
        'space-y-2.5 rounded-md border bg-card px-3 py-2.5',
        lead && 'border-foreground/20',
      )}
    >
      <div className="flex items-start gap-3">
        <p className={cn('min-w-0 flex-1 text-sm', lead && 'font-medium')}>{plan.text}</p>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{plan.code}</span>
      </div>
      <FixActions plan={plan} primary={primary} />
    </li>
  )
}

export function FixList({ fixes, context }: { fixes: Fix[]; context: FixContext }) {
  if (fixes.length === 0) {
    return null
  }

  const plans = fixes.map((fix) => planFix(fix, context))
  const runnable = plans.findIndex((plan) => plan.button)

  return (
    <section className="space-y-2" aria-label="How to fix">
      <h3 className="text-sm font-semibold">How to fix</h3>
      <ol className="space-y-2">
        {plans.map((plan, i) => (
          <FixItem key={`${plan.code}-${i}`} plan={plan} lead={i === 0} primary={i === runnable} />
        ))}
      </ol>
    </section>
  )
}

export function ErrorFix({ failure, context }: { failure: ApiFailure; context: FixContext }) {
  const fix = errorFix(failure.code, failure.fix)

  return fix ? <FixActions plan={planFix(fix, context)} primary /> : null
}
