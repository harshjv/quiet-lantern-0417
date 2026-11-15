import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Clock, Folder, GitBranch, Share2 } from 'lucide-react'
import { useReducer, useState } from 'react'

import {
  agentLabel,
  modelLabel,
  workspaceAgents,
  type AgentEventValue,
  type WorkspaceAgent,
} from '@stationly/protocol'

import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  applyPart,
  applyStored,
  emptyAgentState,
  sessionsOf,
  turnsOf,
  type AgentLivePart,
  type AgentState,
  type ToolCall,
  type Turn,
} from '@/lib/agent-session'
import { agentStreamTypes, taskStreamUrl } from '@/lib/agent-stream'
import { api, ApiFailure, failureText, idempotency, send, unwrap, type Task } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { repositoryName, shortAgo } from '@/lib/format'
import {
  credentialKey,
  githubTokenHelp,
  githubTokenKey,
  githubTokenLabel,
  githubTokenRefused,
  needsGithubToken,
  repositoryUrl,
} from '@/lib/new-task'
import { tasksQuery } from '@/lib/queries'
import { setupFailure } from '@/lib/setup-failure'

import type { Place } from './app'
import { TaskMenu } from './build-task'
import { asRow, useProjectList } from './data'
import { taskTone } from './fixtures'
import { AgentSays, Checklist, Meta, Notice, StatusPill, type Step } from './parts'

type Go = (next: Partial<Place>) => void

type Action = { stored: AgentEventValue } | { part: AgentLivePart }

const reduce = (state: AgentState, action: Action) =>
  'stored' in action ? applyStored(state, action.stored) : applyPart(state, action.part)

const handlers = (dispatch: (action: Action) => void) =>
  Object.fromEntries(
    agentStreamTypes.map((type) => [
      type,
      type === 'message.part'
        ? (data: unknown) =>
            dispatch({
              part: data as AgentLivePart,
            })
        : (data: unknown) =>
            dispatch({
              stored: data as AgentEventValue,
            }),
    ]),
  )

const submitting =
  (send: (text: string) => Promise<unknown>, ready: boolean) =>
  async ({ text }: { text: string }) => {
    if (!ready || !text.trim()) {
      throw new Error('Nothing to send yet')
    }

    await send(text)
  }

const runnerAgents = (Object.keys(workspaceAgents) as WorkspaceAgent[]).filter(
  (agent) => workspaceAgents[agent].runner,
)

export function LiveBuild({ place, go }: { place: Place; go: Go }) {
  const { data, isPending } = useQuery(tasksQuery)

  if (isPending) {
    return null
  }

  const shown = (data?.items ?? []).filter(
    (t) => !place.project || t.project.name === place.project,
  )
  const task =
    place.view === 'new' ? undefined : (shown.find((t) => t.id === place.view) ?? shown[0])

  if (!task) {
    return <LiveComposer project={place.project} go={go} />
  }

  return <LiveThread key={task.id} task={task} go={go} />
}

const setupSteps: { state: string; label: string }[] = [
  {
    state: 'creating',
    label: 'Creating the workspace',
  },
  {
    state: 'setting_up',
    label: 'Cloning and setting up',
  },
  {
    state: 'starting',
    label: 'Starting the agent',
  },
]

function SetupProgress({ task }: { task: Task }) {
  if (task.failure) {
    const failure = setupFailure({
      step: task.failure.step,
      tail: task.failure.tail,
      repository: task.repository,
      branch: task.base_branch,
      project: task.project.name,
    })

    return (
      <Notice tone="danger" title={failure.title}>
        <span className="flex flex-col gap-2">
          {failure.advice}
          {task.failure.tail.length > 0 && (
            <pre className="overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {task.failure.tail.join('\n')}
            </pre>
          )}
        </span>
      </Notice>
    )
  }

  if (!task.setup) {
    return null
  }

  const at = setupSteps.findIndex((step) => step.state === task.setup!.state)
  const steps: Step[] = setupSteps.map((step, i) => ({
    label: step.label,
    state: i < at ? 'done' : i === at ? 'now' : 'todo',
  }))

  return <Checklist steps={steps} />
}

const toolState: Record<
  ToolCall['state'],
  'input-available' | 'output-available' | 'output-error' | 'output-denied'
> = {
  running: 'input-available',
  done: 'output-available',
  failed: 'output-error',
  denied: 'output-denied',
}

function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        toolName={call.name}
        title={call.summary}
        state={toolState[call.state]}
      />
      {call.output && (
        <ToolContent>
          <ToolOutput
            output={call.state === 'failed' ? undefined : call.output}
            errorText={call.state === 'failed' ? call.output : undefined}
          />
        </ToolContent>
      )}
    </Tool>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <>
      {turn.prompt !== null && (
        <Message from="user">
          <MessageContent>{turn.prompt}</MessageContent>
        </Message>
      )}
      {turn.items.map((item) =>
        item.kind === 'tools' ? (
          item.calls.map((call) => <ToolCallView key={call.id} call={call} />)
        ) : (
          <AgentSays key={`${item.kind}-${item.id}`}>
            <MessageResponse>{item.text}</MessageResponse>
          </AgentSays>
        ),
      )}
      {turn.failure && (
        <Notice tone="danger" title="This turn failed">
          {turn.failure}
        </Notice>
      )}
    </>
  )
}

function LiveThread({ task, go }: { task: Task; go: Go }) {
  const queries = useQueryClient()
  const [state, dispatch] = useReducer(reduce, emptyAgentState)
  const [problem, setProblem] = useState<string | null>(null)
  const row = asRow(task)
  const target = api.v1.tasks({
    task: task.id,
  })

  useEventStream(taskStreamUrl(task.id), handlers(dispatch))

  const turns = sessionsOf(state.events).flatMap((session) => turnsOf(state, session.id))
  const refresh = () =>
    void queries.invalidateQueries({
      queryKey: ['tasks'],
    })
  const reply = useMutation({
    mutationFn: (text: string) =>
      unwrap(
        target.prompts.post(
          {
            text,
          },
          idempotency(),
        ),
      ),
    onSuccess: () => setProblem(null),
    onError: (error) => setProblem(failureText(error)),
  })
  const stop = useMutation({
    mutationFn: () => unwrap(target.interrupt.post({}, idempotency())),
    onError: (error) => setProblem(failureText(error)),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(target.delete(undefined, idempotency())),
    onSuccess: () => {
      refresh()
      go({
        view: 'new',
      })
    },
    onError: (error) => setProblem(failureText(error)),
  })
  const restart = useMutation({
    mutationFn: async () => {
      const next = await unwrap(
        api.v1.tasks.post(
          {
            project: task.project.id,
            repository: task.repository,
            base_branch: task.base_branch ?? undefined,
            agent: task.agent,
            model: task.model ?? undefined,
            prompt: task.prompt ?? task.title,
          },
          idempotency(),
        ),
      )

      await unwrap(target.delete(undefined, idempotency())).catch(() => undefined)

      return next
    },
    onSuccess: (next) => {
      refresh()
      go({
        view: next.id,
      })
    },
    onError: (error) => setProblem(failureText(error)),
  })

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 px-6 pt-6">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <StatusPill tone={taskTone[row.state]}>{row.reason}</StatusPill>
            <Meta icon={Folder} label="Project">
              {task.project.name}
            </Meta>
            <Meta icon={GitBranch} label="Branch">
              {task.branch}
            </Meta>
            <Meta icon={Bot} label="Agent">
              {task.model ? modelLabel(task.model) : agentLabel(task.agent)}
            </Meta>
            <Meta icon={Clock} label="Started">
              {shortAgo(task.created_at)}
            </Meta>
          </div>
        </div>
        <Button variant="ghost" size="sm" disabled>
          <Share2 /> Share
        </Button>
        <TaskMenu branch={task.branch} own remove={() => remove.mutate()} />
      </div>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="px-0">
          {turns.length === 0 && task.prompt && (
            <Message from="user">
              <MessageContent>{task.prompt}</MessageContent>
            </Message>
          )}
          <SetupProgress task={task} />
          {turns.map((turn) => (
            <TurnView key={turn.key} turn={turn} />
          ))}
        </ConversationContent>
      </Conversation>

      {problem && (
        <Notice tone="danger" title="That did not go through">
          {problem}
        </Notice>
      )}

      {task.failure ? (
        <div className="mb-6 flex items-center gap-3">
          <span className="flex-1 text-sm text-muted-foreground">
            This task cannot continue. A new task starts over with the same prompt.
          </span>
          <Button disabled={restart.isPending} onClick={() => restart.mutate()}>
            Start a new task
          </Button>
        </div>
      ) : (
        <PromptInputProvider>
          <PromptInput className="mb-6" onSubmit={submitting(reply.mutateAsync, true)}>
            <PromptInputBody>
              <PromptInputTextarea placeholder="Reply to continue this task…" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <span className="text-xs text-muted-foreground">
                  Sends to the agent working on this task.
                </span>
              </PromptInputTools>
              <PromptInputSubmit
                status={
                  task.status === 'working'
                    ? 'streaming'
                    : reply.isPending
                      ? 'submitted'
                      : undefined
                }
                onStop={() => stop.mutate()}
              />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      )}
    </div>
  )
}

type Blocked =
  | { kind: 'key' }
  | { kind: 'token' }
  | { kind: 'refused'; text: string }
  | { kind: 'other'; text: string }

const blockedBy = (error: unknown): Blocked => {
  if (needsGithubToken(error)) {
    return {
      kind: 'token',
    }
  }

  if (githubTokenRefused(error)) {
    return {
      kind: 'refused',
      text: failureText(error),
    }
  }

  const issues =
    error instanceof ApiFailure
      ? (error.details.issues as { path: string }[] | undefined)
      : undefined

  if (issues?.some((issue) => issue.path === '/agent')) {
    return {
      kind: 'key',
    }
  }

  return {
    kind: 'other',
    text: failureText(error),
  }
}

const storeProjectKey = (project: string, key: string, value: string) =>
  send(
    api.v1
      .projects({
        project,
      })
      .variables.patch(
        {
          environment: 'default',
          set: [
            {
              key,
              kind: 'sealed',
              value: value.trim(),
            },
          ],
        },
        idempotency(),
      ),
  )

function LiveComposer({ project: preferred, go }: { project: string | null; go: Go }) {
  const queries = useQueryClient()
  const projects = useProjectList()
  const [project, setProject] = useState(preferred ?? projects[0]?.id ?? '')
  const [agent, setAgent] = useState<WorkspaceAgent>(runnerAgents[0] ?? 'claude')
  const [model, setModel] = useState(workspaceAgents[agent].models[0]?.id ?? '')
  const [repository, setRepository] = useState('')
  const [secret, setSecret] = useState('')
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const preset = workspaceAgents[agent]
  const url = repositoryUrl(repository)
  const chosen = project || projects[0]?.id || ''
  const start = useMutation({
    mutationFn: async (prompt: string) => {
      if (blocked?.kind === 'key' && secret.trim()) {
        await storeProjectKey(chosen, credentialKey(preset.keys, secret), secret)
      }

      if (blocked?.kind === 'token' && secret.trim()) {
        await storeProjectKey(chosen, githubTokenKey, secret)
      }

      return unwrap(
        api.v1.tasks.post(
          {
            project: chosen,
            repository: url!,
            agent,
            model: model || undefined,
            prompt,
          },
          idempotency(),
        ),
      )
    },
    onSuccess: (task) => {
      setBlocked(null)
      setSecret('')
      void queries.invalidateQueries({
        queryKey: ['tasks'],
      })
      go({
        project: null,
        view: task.id,
      })
    },
    onError: (error) => {
      setSecret('')
      setBlocked(blockedBy(error))
    },
  })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="font-display text-2xl">What should we build?</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="live-project">Project</Label>
          <PromptInputSelect value={chosen} onValueChange={setProject}>
            <PromptInputSelectTrigger id="live-project" aria-label="Project" className="w-48">
              <PromptInputSelectValue />
            </PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {projects.map((p) => (
                <PromptInputSelectItem key={p.id} value={p.id}>
                  {p.name}
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="live-repository">Repository</Label>
          <Input
            id="live-repository"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/owner/name"
            aria-invalid={repository !== '' && !url}
          />
        </div>
      </div>
      {(blocked?.kind === 'key' || blocked?.kind === 'token') && (
        <Notice
          tone="warning"
          title={
            blocked.kind === 'key'
              ? `${chosen} has no ${preset.keyLabel}`
              : `${githubTokenLabel} needed`
          }
        >
          <span className="flex flex-col gap-2">
            {blocked.kind === 'key'
              ? `${preset.keyHelp} Stationly stores it sealed for the whole project.`
              : githubTokenHelp(chosen, repositoryName(url ?? repository))}
            <Input
              type="password"
              aria-label={blocked.kind === 'key' ? preset.keyLabel : githubTokenLabel}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </span>
        </Notice>
      )}
      {(blocked?.kind === 'refused' || blocked?.kind === 'other') && (
        <Notice tone="danger" title="The task did not start">
          {blocked.text}
        </Notice>
      )}
      <PromptInputProvider>
        <PromptInput onSubmit={submitting(start.mutateAsync, Boolean(url && chosen))}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Describe the task. An agent works on it on a new branch and shows you what it changed." />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputSelect
                value={agent}
                onValueChange={(next) => {
                  setAgent(next as WorkspaceAgent)
                  setModel(workspaceAgents[next as WorkspaceAgent].models[0]?.id ?? '')
                }}
              >
                <PromptInputSelectTrigger aria-label="Agent">
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {runnerAgents.map((a) => (
                    <PromptInputSelectItem key={a} value={a}>
                      {workspaceAgents[a].label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
              {preset.models.length > 0 && (
                <PromptInputSelect value={model} onValueChange={setModel}>
                  <PromptInputSelectTrigger aria-label="Model">
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {preset.models.map((m) => (
                      <PromptInputSelectItem key={m.id} value={m.id}>
                        {m.label}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              )}
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!url || !chosen || start.isPending}
              status={start.isPending ? 'submitted' : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
      <p className="text-sm text-muted-foreground">
        Runs in project {chosen || 'none yet'} on a new branch, in a workspace of its own. Anything
        that needs approval is stopped and shown to you.
      </p>
    </div>
  )
}
