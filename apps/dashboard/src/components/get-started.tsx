import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { releaseConfig } from '@stationly/protocol/release-config'

import { Code } from '@/components/code'
import { NewProject } from '@/components/new-project'
import { NewService, type ServicePreset } from '@/components/new-service'
import { NewSandbox } from '@/components/sandboxes-panel'
import { ServiceStatusDot } from '@/components/status'
import { Button } from '@/components/ui/button'
import type { Project } from '@/lib/api'
import { passkeysAvailable, passkeysQuery, sessionQuery } from '@/lib/auth'
import { guideProgress, guideVisible, setGuideHidden, useGuideHidden } from '@/lib/first-run'
import { byName, plural } from '@/lib/format'
import { client } from '@/lib/labels'
import { agentTokensQuery, environmentQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const hello: ServicePreset = {
  name: 'hello',
  image: releaseConfig.acceptance_images.whoami,
  port: {
    port: '80',
    protocol: 'http',
  },
}

const helloSource = hello.image.slice(0, hello.image.indexOf('@'))

type Step = {
  id: string
  title: string
  done: boolean | undefined
  detail: ReactNode
  action?: (next: boolean) => ReactNode
}

type Dialog = 'project' | 'service' | 'sandbox' | null

const variant = (next: boolean) => (next ? 'default' : 'outline')

function useSteps(projects: Project[], open: (dialog: Dialog) => void) {
  const session = useQuery(sessionQuery)
  const passkeys = useQuery(passkeysQuery)
  const tokens = useQuery({
    ...agentTokensQuery,
    refetchInterval: ({ state }) =>
      state.data?.length && !state.data.some((token) => token.last_used_at) ? 5000 : false,
  })
  const first = [...projects].sort(byName)[0]
  const keys = passkeys.data?.length
  const { healthy, starting, services, sandboxes, used, waiting, done } = guideProgress({
    projects,
    totp: session.data ? Boolean(session.data.user.twoFactorEnabled) : undefined,
    passkeys: keys,
    passkeysSettled: Boolean(passkeys.data) || passkeys.isError,
    tokens: tokens.data,
  })
  const needsProject = 'Create a project first.'

  const steps: Step[] = [
    {
      id: 'secure',
      title: 'Secure your account',
      done: done.secure,
      detail: done.secure
        ? keys
          ? `${plural(keys, 'passkey')} added`
          : 'TOTP is on'
        : passkeysAvailable()
          ? 'Add a passkey or TOTP, so a password alone can’t sign in.'
          : 'Set up TOTP, so a password alone can’t sign in.',
      action: (next) => (
        <Button asChild size="sm" variant={variant(next)}>
          <Link
            to="/account"
            search={{
              enroll: true,
            }}
          >
            Secure account
          </Link>
        </Button>
      ),
    },
    {
      id: 'project',
      title: 'Create a project',
      done: done.project,
      detail: first
        ? projects.length > 1
          ? `${first.name} and ${plural(projects.length - 1, 'other')}`
          : first.name
        : 'A project groups services that deploy together.',
      action: (next) => (
        <Button size="sm" variant={variant(next)} onClick={() => open('project')}>
          Create project
        </Button>
      ),
    },
    {
      id: 'service',
      title: 'Deploy your first service',
      done: done.service,
      detail:
        healthy > 0 ? (
          <span className="inline-flex items-center gap-2">
            <ServiceStatusDot status="green" />
            {plural(healthy, 'healthy service')}
          </span>
        ) : starting > 0 ? (
          <span className="inline-flex items-center gap-2">
            <ServiceStatusDot status="amber" />
            Starting. This step checks off when it turns healthy.
          </span>
        ) : services > 0 ? (
          'No service is healthy yet.'
        ) : first ? (
          <>
            Try <Code>{helloSource}</Code>, a small web server that answers with the request it got.
          </>
        ) : (
          needsProject
        ),
      action: first
        ? (next) =>
            services > 0 ? (
              <Button asChild size="sm" variant="outline">
                <Link
                  to="/projects/$project"
                  params={{
                    project: first.name,
                  }}
                >
                  Open {first.name}
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant={variant(next)} onClick={() => open('service')}>
                Deploy {hello.name}
              </Button>
            )
        : undefined,
    },
    {
      id: 'sandbox',
      title: 'Open a sandbox',
      done: done.sandbox,
      detail:
        sandboxes > 0
          ? plural(sandboxes, 'sandbox', 'sandboxes')
          : first
            ? 'A shell on a fresh machine, right in your browser.'
            : needsProject,
      action: first
        ? (next) => (
            <Button size="sm" variant={variant(next)} onClick={() => open('sandbox')}>
              Create sandbox
            </Button>
          )
        : undefined,
    },
    {
      id: 'agent',
      title: 'Connect an agent',
      done: done.agent,
      detail: used
        ? `${client(used.name)} is connected`
        : waiting
          ? `${client(waiting.name)} has its token. Waiting for its first call.`
          : 'Claude Code, Cursor, Codex or any MCP client.',
      action: (next) => (
        <Button asChild size="sm" variant={variant(next)}>
          <Link to="/agents">Connect agent</Link>
        </Button>
      ),
    },
  ]

  return {
    steps,
    first,
  }
}

export function useGetStarted(projects: Project[]) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const { steps, first } = useSteps(projects, setDialog)
  const hidden = useGuideHidden()
  const known = steps.every((step) => step.done !== undefined)
  const complete = steps.every((step) => step.done === true)
  const [seenOpen, setSeenOpen] = useState(false)

  if (known && !complete && !seenOpen) {
    setSeenOpen(true)
  }

  useEffect(() => {
    if (complete && hidden) {
      setGuideHidden(false)
    }
  }, [complete, hidden])

  return {
    steps,
    first,
    dialog,
    setDialog,
    complete,
    visible: guideVisible({
      hidden,
      known,
      complete,
      seenOpen,
    }),
  }
}

function StepMark({ done }: { done: boolean | undefined }) {
  const [was, setWas] = useState(done)
  const [fresh, setFresh] = useState(false)

  if (was !== done) {
    setWas(done)
    setFresh(was === false && done === true)
  }

  return done ? (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
        fresh && 'motion-safe:animate-in motion-safe:duration-500 motion-safe:zoom-in-50',
      )}
    >
      <Check className="size-3" strokeWidth={3} aria-hidden />
    </span>
  ) : (
    <span
      className="size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/50"
      aria-hidden
    />
  )
}

function Dialogs({ guide }: { guide: ReturnType<typeof useGetStarted> }) {
  const environment = useQuery({
    ...environmentQuery(guide.first?.default_environment_id ?? ''),
    enabled: Boolean(guide.first),
  })
  const close = (open: boolean) => {
    if (!open) {
      guide.setDialog(null)
    }
  }

  if (guide.dialog === 'project') {
    return <NewProject open onOpenChange={close} />
  }

  if (!guide.first || !guide.dialog || !environment.data) {
    return null
  }

  return guide.dialog === 'service' ? (
    <NewService environment={environment.data} preset={hello} open onOpenChange={close} />
  ) : (
    <NewSandbox
      environment={environment.data}
      scope={{
        project: guide.first.name,
        environment: environment.data.name,
      }}
      open
      onOpenChange={close}
    />
  )
}

export function GetStarted({ guide }: { guide: ReturnType<typeof useGetStarted> }) {
  const finished = guide.steps.filter((step) => step.done).length
  const next = guide.steps.find((step) => !step.done)

  return (
    <section
      aria-labelledby="get-started-title"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3">
        <div className="min-w-0 space-y-0.5">
          <h2 id="get-started-title" className="text-sm font-semibold">
            {guide.complete ? 'You’re all set' : 'Get started with Stationly'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {guide.complete
              ? 'Your first service is live, you have a sandbox and an agent is connected.'
              : 'From a fresh instance to a live URL, a shell and an agent that deploys.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {finished} of {guide.steps.length} done
          </span>
          <Button variant="ghost" size="sm" onClick={() => setGuideHidden(true)}>
            Hide
          </Button>
        </div>
      </div>
      <div
        className="mx-4 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Get started progress"
        aria-valuemin={0}
        aria-valuemax={guide.steps.length}
        aria-valuenow={finished}
      >
        <div
          className="h-full rounded-full bg-emerald-600 motion-safe:transition-[width] motion-safe:duration-500 dark:bg-emerald-500"
          style={{
            width: `${(finished / guide.steps.length) * 100}%`,
          }}
        />
      </div>
      <ol className="mt-3 divide-y border-t">
        {guide.steps.map((step) => (
          <li
            key={step.id}
            className="flex min-h-13 flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:items-center"
          >
            <StepMark done={step.done} />
            <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:grid sm:basis-auto sm:grid-cols-[13rem_1fr] sm:items-center sm:gap-4">
              <p className={cn('text-sm font-medium', step.done && 'text-muted-foreground')}>
                {step.title}
                <span className="sr-only">{step.done ? ', done' : ', to do'}</span>
              </p>
              <p className="text-sm text-muted-foreground">{step.detail}</p>
            </div>
            {!step.done && step.action && (
              <div className="ml-8 shrink-0 sm:ml-0">{step.action(step === next)}</div>
            )}
          </li>
        ))}
      </ol>
      <Dialogs guide={guide} />
    </section>
  )
}
