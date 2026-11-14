import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { workspaceAgents } from '@stationly/protocol'

import { Code } from '@/components/code'
import { CredentialField } from '@/components/credential-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { api, failureText, idempotency, send, type AgentSession, type Sandbox } from '@/lib/api'
import { githubTokenHelp, githubTokenKey, githubTokenLabel } from '@/lib/new-task'
import { setupFailure } from '@/lib/setup-failure'
import { startTask, storeProjectKey } from '@/lib/start-task'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Setup = NonNullable<AgentSession['setup']>

export const setupSteps = [
  'Workspace created',
  'Starting the machine',
  'Cloning and setting up',
  'Starting the agent',
]

export const activeStep = (state: Setup['state']) =>
  state === 'creating' ? 1 : state === 'setting_up' ? 2 : 3

function SetupFailed({
  session,
  sandbox,
  setup,
}: {
  session: AgentSession
  sandbox: Sandbox | undefined
  setup: Setup
}) {
  const navigate = useNavigate()
  const [token, setToken] = useState('')
  const workspace = sandbox?.workspace
  const failure = setupFailure({
    step: setup.step,
    tail: setup.tail,
    repository: workspace?.repository ?? '',
    branch: workspace?.branch ?? null,
    project: session.project.name,
  })
  const again = useMutation({
    mutationFn: async () => {
      if (!workspace || !sandbox) {
        throw new Error('The workspace is not loaded yet.')
      }

      if (failure.needsToken) {
        await storeProjectKey(
          {
            project: session.project.id,
            environment: session.environment.name,
          },
          githubTokenKey,
          token,
        )
      }

      const started = await startTask({
        environment: sandbox.environment_id,
        agent: workspace.agent,
        repository: workspace.repository,
        prompt: setup.prompt ?? session.title ?? '',
        model: setup.model ?? workspaceAgents[workspace.agent].models[0]?.id ?? '',
        memory: sandbox.size.memory_bytes,
      })

      await send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          .delete(undefined, idempotency()),
      ).catch(() => undefined)

      return started
    },
    onSuccess: (started) =>
      void navigate({
        to: '/sessions/$sandbox/$session',
        params: {
          sandbox: started.sandbox.id,
          session: started.session_id,
        },
      }),
  })
  const ready =
    Boolean(workspace && (setup.prompt ?? session.title)) &&
    (!failure.needsToken || token.trim() !== '')

  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription className="space-y-3">
        <p className="font-medium">{failure.title}</p>
        <p>{failure.advice}</p>
        {setup.tail.length > 0 && (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {setup.tail.join('\n')}
          </pre>
        )}
        {failure.needsToken && (
          <CredentialField
            label={githubTokenLabel}
            project={session.project.name}
            value={token}
            onChange={setToken}
            help={githubTokenHelp(session.project.name, workspace?.repository ?? 'the repository')}
          />
        )}
        {again.isError && <p>{failureText(again.error)}</p>}
        <Button size="sm" disabled={!ready || again.isPending} onClick={() => again.mutate()}>
          {again.isPending && <Loader2 className="animate-spin" />}
          {failure.needsToken ? 'Add token and start a new task' : 'Start a new task'}
        </Button>
        {setup.run_id && (
          <p className="text-xs text-muted-foreground">
            Setup run{' '}
            <Code copy={`sly runs get ${setup.run_id}`}>{`sly runs get ${setup.run_id}`}</Code>
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function TaskSetup({
  setup,
  session,
  sandbox,
}: {
  setup: Setup
  session: AgentSession
  sandbox: Sandbox | undefined
}) {
  const active = activeStep(setup.state)
  const failed = setup.state === 'failed'

  return (
    <div className="space-y-3">
      <ol className="space-y-2" aria-label="Setting up the workspace">
        {setupSteps.map((step, index) => {
          const done = index < active
          const current = index === active && !failed

          return (
            <li key={step} className="flex items-center gap-2.5 text-sm">
              {done ? (
                <Check className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
              ) : current ? (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden
                />
              ) : index === active && failed ? (
                <CircleAlert className={cn('size-4', toneText.danger)} aria-hidden />
              ) : (
                <span className="size-4 rounded-full border border-dashed" aria-hidden />
              )}
              <span className={cn(!done && !current && 'text-muted-foreground')}>{step}</span>
              <span className="sr-only">{done ? ', done' : current ? ', in progress' : ''}</span>
            </li>
          )
        })}
      </ol>
      {failed && <SetupFailed session={session} sandbox={sandbox} setup={setup} />}
    </div>
  )
}
