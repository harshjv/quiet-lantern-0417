import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ExternalLink, Eye, Folder, Loader2, Rocket, SearchX } from 'lucide-react'
import { useReducer, useState, type ReactNode } from 'react'

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
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai-elements/tool'
import { Code, Output } from '@/components/code'
import { CheckboxField, Field } from '@/components/field'
import { Name } from '@/components/name'
import { NewProject } from '@/components/new-project'
import { EmptyState } from '@/components/page'
import { Failure } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  applyPart,
  applyProgress,
  applyStored,
  emptyAgentState,
  isInstanceAdmin,
  runningTool,
  sessionsOf,
  turnsOf,
  typedPromptCount,
  type AgentLivePart,
  type AgentProgress,
  type AgentState,
  type ToolCall,
  type Turn,
} from '@/lib/agent-session'
import { agentStreamTypes, taskStreamUrl } from '@/lib/agent-stream'
import {
  api,
  ApiFailure,
  failureText,
  idempotency,
  send,
  unwrap,
  type MyRepositories,
  type Task,
} from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { blank, plural, repositoryName, shortAgo } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { newTaskTo, placeTo, taskTo, type TaskFilePlace } from '@/lib/links'
import {
  credentialKey,
  githubTokenHelp,
  githubTokenKey,
  githubTokenLabel,
  githubTokenRefused,
  needsGithubToken,
  projectRepositories,
  repositoryUrl,
  taskBrief,
} from '@/lib/new-task'
import { productionOf } from '@/lib/place'
import {
  appsQuery,
  membersQuery,
  meQuery,
  myRepositoriesQuery,
  projectsQuery,
  taskQuery,
  tasksQuery,
} from '@/lib/queries'
import { setupFailure } from '@/lib/setup-failure'
import { toneText } from '@/lib/tone'

import { asRow, taskTone, useProjectList } from './data'
import { fixTarget, useFixPrefill, type FixTarget } from './fix-live'
import { AgentSays, Checklist, Notice, StatusPill, type Step } from './parts'
import {
  PullRequestLink,
  ShipDecision,
  ShipDeployments,
  shipProblem,
  useShipStatus,
  type ShipApproval,
} from './ship-approval'
import { changedFileCount, ChangesView, TaskChanges } from './task-changes'
import { TaskFiles } from './task-files'
import { TaskMenu } from './task-menu'
import { TaskTerminal } from './task-terminal'

type Action = { stored: AgentEventValue } | { part: AgentLivePart } | { progress: AgentProgress }

const reduce = (state: AgentState, action: Action) =>
  'stored' in action
    ? applyStored(state, action.stored)
    : 'part' in action
      ? applyPart(state, action.part)
      : applyProgress(state, action.progress)

const liveAction = (type: string, data: unknown): Action =>
  type === 'message.part'
    ? {
        part: data as AgentLivePart,
      }
    : type === 'progress'
      ? {
          progress: data as AgentProgress,
        }
      : {
          stored: data as AgentEventValue,
        }

const handlers = (dispatch: (action: Action) => void) =>
  Object.fromEntries(
    agentStreamTypes.map((type) => [type, (data: unknown) => dispatch(liveAction(type, data))]),
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

const taskTabs = ['conversation', 'changes', 'terminal', 'files'] as const

type TaskTab = (typeof taskTabs)[number]

export function TaskView({
  id,
  project,
  tab,
  place,
}: {
  id: string
  project: string
  tab: string | null
  place: TaskFilePlace
}) {
  const { data: task, error, refetch } = useQuery(taskQuery(id))

  if (error instanceof ApiFailure && error.status === 404) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col px-6 py-8">
        <h1 className="sr-only">Task not found</h1>
        <EmptyState
          icon={SearchX}
          title="This task doesn’t exist"
          description="Deleted, or the link is wrong."
          action={
            <Button asChild size="sm" variant="outline">
              <Link {...newTaskTo(project)}>New task</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col px-6 py-8">
        <Failure error={error} title="Couldn’t load this task" onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!task) {
    return null
  }

  return (
    <LiveThread
      key={task.id}
      task={task}
      tab={taskTabs.find((t) => t === tab) ?? 'conversation'}
      place={place}
    />
  )
}

export function NewTask({ project, fix }: { project: string; fix: string | null }) {
  return fix ? (
    <FixComposer project={project} target={fixTarget(fix)} />
  ) : (
    <LiveComposer project={project} />
  )
}

const setupSteps: { state: string; label: string }[] = [
  {
    state: 'creating',
    label: 'Starting',
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
    })

    return (
      <Notice tone="danger" title={failure.title}>
        <span className="flex flex-col gap-2">
          {failure.advice}
          {task.failure.tail.length > 0 && <Output>{task.failure.tail.join('\n')}</Output>}
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
        title={call.summary.split('\n', 1)[0]}
        state={toolState[call.state]}
      />
      <ToolContent className="flex flex-col gap-3 p-3">
        <Output className="break-all">{call.summary}</Output>
        {call.output ? (
          <ToolOutput
            output={call.state === 'failed' ? undefined : call.output}
            errorText={call.state === 'failed' ? call.output : undefined}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {call.state === 'running' ? 'Running' : 'Output is kept only for calls that fail.'}
          </p>
        )}
      </ToolContent>
    </Tool>
  )
}

function ProgressView({ progress }: { progress: AgentProgress }) {
  const { data } = progress

  if (data.kind === 'writing') {
    return (
      <AgentSays>
        <MessageResponse>{data.text ?? ''}</MessageResponse>
      </AgentSays>
    )
  }

  if (data.kind === 'retrying') {
    return (
      <p className="text-xs text-muted-foreground">
        Retrying after an API error{data.attempt ? ` (attempt ${data.attempt})` : ''}
      </p>
    )
  }

  return (
    <Shimmer className="text-xs">
      {data.tokens ? `Thinking, about ${data.tokens} tokens` : 'Thinking'}
    </Shimmer>
  )
}

type ThreadActions = {
  decide: (approval: string, behavior: 'allow' | 'deny', message?: string) => void
  allow: (summary: string) => void
  busy: boolean
}

type ApprovalItem = Extract<Turn['items'][number], { kind: 'approval' }>
type BlockedItem = Extract<Turn['items'][number], { kind: 'blocked' }>

const field = (input: Record<string, unknown>, key: string) => {
  const value = input[key]

  return typeof value === 'string' ? value : null
}

const approvalBody = (item: ApprovalItem) => {
  const command = field(item.input, 'command')
  const path = field(item.input, 'file_path')
  const content = field(item.input, 'content') ?? field(item.input, 'new_string')

  if (command !== null) {
    return command
  }

  if (path !== null) {
    return content === null ? path : `${path}\n\n${content}`
  }

  return JSON.stringify(item.input, null, 2)
}

const closedText = {
  allowed: 'Allowed by you',
  denied: 'Denied by you',
  expired: 'Expired, the agent was told no',
}

function ApprovalCard({ item, actions }: { item: ApprovalItem; actions: ThreadActions }) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const until = new Date(item.expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="flex flex-col gap-3 border border-border p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">
          Claude asks to use <Code className="text-xs">{item.tool}</Code>
        </span>
        {item.status === 'pending' && (
          <span className="text-xs text-muted-foreground">Waits until {until}</span>
        )}
      </div>
      <Output className="max-h-64">{approvalBody(item)}</Output>
      {item.truncated && (
        <p className={`text-xs ${toneText.warning}`}>
          Cut to fit. Deny it if you can’t tell what it runs.
        </p>
      )}
      {item.status !== 'pending' ? (
        <p className="text-xs text-muted-foreground">
          {closedText[item.status]}
          {item.message ? `: ${item.message}` : ''}
        </p>
      ) : denying ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={reason}
            placeholder="Tell the agent why (optional)"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="destructive"
            disabled={actions.busy}
            onClick={() => actions.decide(item.approvalId, 'deny', reason.trim() || undefined)}
          >
            Deny
          </Button>
          <Button variant="ghost" onClick={() => setDenying(false)}>
            Back
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button disabled={actions.busy} onClick={() => actions.decide(item.approvalId, 'allow')}>
            Allow
          </Button>
          <Button variant="outline" disabled={actions.busy} onClick={() => setDenying(true)}>
            Deny
          </Button>
        </div>
      )}
    </div>
  )
}

function BlockedLine({ item, actions }: { item: BlockedItem; actions: ThreadActions }) {
  const [sent, setSent] = useState(false)

  return (
    <div className="flex flex-col gap-2 border border-border p-3">
      <p className="text-sm">
        Auto mode blocked {item.tool}
        {item.reason ? <span className="text-muted-foreground"> {item.reason}</span> : null}
      </p>
      {item.summary && <Output className="max-h-40">{item.summary}</Output>}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={sent || actions.busy || !item.summary}
          onClick={() => {
            setSent(true)
            actions.allow(item.summary)
          }}
        >
          {sent ? 'Approval sent' : 'Allow it'}
        </Button>
      </div>
    </div>
  )
}

function TurnView({ turn, actions }: { turn: Turn; actions: ThreadActions }) {
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
        ) : item.kind === 'note' ? (
          <p key={item.id} className="text-xs text-muted-foreground">
            {item.text}
          </p>
        ) : item.kind === 'approval' ? (
          <ApprovalCard key={item.id} item={item} actions={actions} />
        ) : item.kind === 'blocked' ? (
          <BlockedLine key={item.id} item={item} actions={actions} />
        ) : item.kind === 'changes' ? (
          <ChangesView key={item.id} item={item} />
        ) : (
          <AgentSays key={`${item.kind}-${item.id}`}>
            <MessageResponse>{item.text}</MessageResponse>
          </AgentSays>
        ),
      )}
      {turn.stopped && <p className="text-xs text-muted-foreground">Stopped</p>}
      {turn.failure && (
        <Notice tone="danger" title="This turn failed">
          {turn.failure}
        </Notice>
      )}
    </>
  )
}

function LiveThread({ task, tab, place }: { task: Task; tab: TaskTab; place: TaskFilePlace }) {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reduce, emptyAgentState)
  const [problem, setProblem] = useState<string | null>(null)
  const row = asRow(task)
  const target = api.v1.tasks({
    task: task.id,
  })

  useEventStream(taskStreamUrl(task.id), handlers(dispatch))

  const [sent, setSent] = useState<{ text: string; place: number }[]>([])
  const turns = sessionsOf(state.events).flatMap((session) => turnsOf(state, session.id))
  const prompted = typedPromptCount(state)
  const unseen = sent.filter((item) => item.place >= prompted)
  const last = turns.at(-1)
  const open = !!last && last.endedAt === null
  const progress = open && unseen.length === 0 ? state.progress : null
  const busy =
    !progress && (unseen.length > 0 || (task.status === 'working' && open && !runningTool(last)))
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
    onMutate: (text) =>
      setSent([
        ...unseen,
        {
          text,
          place: prompted + unseen.length,
        },
      ]),
    onSuccess: () => setProblem(null),
    onError: (error, text) => {
      setSent((list) => list.filter((item) => item.text !== text))
      setProblem(failureText(error))
    },
  })
  const decide = useMutation({
    mutationFn: (input: { approval: string; behavior: 'allow' | 'deny'; message?: string }) =>
      unwrap(
        target
          .approvals({
            approval: input.approval,
          })
          .decision.post(
            {
              decision: input.behavior,
              ...(input.message
                ? {
                    message: input.message,
                  }
                : {}),
            },
            idempotency(),
          ),
      ),
    onSuccess: () => setProblem(null),
    onError: (error) => setProblem(failureText(error)),
  })
  const actions: ThreadActions = {
    decide: (approval, behavior, message) =>
      decide.mutate({
        approval,
        behavior,
        message,
      }),
    allow: (summary) =>
      reply.mutate(`I approve this exact action, and you may run it now: ${summary}`),
    busy: decide.isPending || reply.isPending,
  }
  const [previewNote, setPreviewNote] = useState<string | null>(null)
  const preview = useMutation({
    mutationFn: () => unwrap(target.preview.post(undefined, idempotency())),
    onSuccess: (made) => {
      setProblem(null)
      setPreviewNote(`${made.preview.name}${made.url ? ` at ${made.url}` : ''}`)
      refresh()
    },
    onError: (error) => setProblem(failureText(error)),
  })
  const ship = useMutation({
    mutationFn: () => unwrap(target.ship.post(undefined, idempotency())),
    onSuccess: () => {
      setProblem(null)
      refresh()
    },
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
      void navigate(newTaskTo(task.project.name))
    },
    onError: (error) => setProblem(failureText(error)),
  })
  const restart = useMutation({
    mutationFn: async (isolated: boolean) => {
      const next = await unwrap(
        api.v1.tasks.post(
          {
            project: task.project.id,
            repository: task.repository,
            base_branch: task.base_branch ?? undefined,
            agent: task.agent,
            model: task.model ?? undefined,
            ...taskBrief(task.prompt, task.title),
            isolated,
          },
          idempotency(),
        ),
      )

      await unwrap(target.delete(undefined, idempotency())).catch(() => undefined)

      return next
    },
    onSuccess: (next) => {
      refresh()
      void navigate(taskTo(task.project.name, next.id))
    },
    onError: (error) => setProblem(failureText(error)),
  })

  const owned = useOwned(task)
  const shownTabs = taskTabs.filter((t) => t !== 'terminal' || owned)
  const shown = shownTabs.find((t) => t === tab) ?? 'conversation'
  const changedFiles = changedFileCount(turns)

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 px-6 pt-6">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold">
            <Name kind="task" chip={false} className="font-semibold">
              {task.title}
            </Name>
          </h1>
          <StatusPill tone={taskTone[row.state]}>{row.reason}</StatusPill>
          {row.detail && (
            <span className="shrink-0 text-sm text-muted-foreground">{row.detail}</span>
          )}
        </div>
        {task.preview?.url && (
          <Button asChild variant="outline" size="sm">
            <a href={task.preview.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open preview
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={preview.isPending}
          onClick={() => preview.mutate()}
        >
          <Eye /> {task.preview ? 'Update preview' : 'Make a preview'}
        </Button>
        {task.ship?.status !== 'approved' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={ship.isPending || task.ship?.ship?.phase === 'pushing'}
            onClick={() => ship.mutate()}
          >
            <Rocket /> {task.ship ? 'Ship again' : 'Ship it'}
          </Button>
        )}
        <TaskMenu branch={task.branch} remove={() => remove.mutate()} />
      </div>
      <TaskFacts task={task} />

      <Tabs
        value={shown}
        onValueChange={(next) => {
          const found = taskTabs.find((t) => t === next)

          if (found) {
            void navigate(
              taskTo(task.project.name, task.id, found === 'conversation' ? undefined : found),
            )
          }
        }}
        className="min-h-0 flex-1"
      >
        <TabsList>
          {shownTabs.map((id) => (
            <TabsTrigger key={id} value={id}>
              {taskTabTitle[id]}
              {id === 'changes' && changedFiles > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {plural(changedFiles, 'file')}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="conversation" className="mt-2 flex min-h-0 flex-col gap-4">
          <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
            <Conversation className="min-h-0 flex-1">
              <ConversationContent className="px-0">
                {turns.length === 0 && task.prompt && (
                  <Message from="user">
                    <MessageContent>{task.prompt}</MessageContent>
                  </Message>
                )}
                <SetupProgress task={task} />
                {turns.map((turn) => (
                  <TurnView key={turn.key} turn={turn} actions={actions} />
                ))}
                {unseen.map((item) => (
                  <Message key={`sent-${item.place}`} from="user">
                    <MessageContent>{item.text}</MessageContent>
                  </Message>
                ))}
                {progress && <ProgressView progress={progress} />}
                {busy && (
                  <Shimmer className="text-xs">
                    {unseen.length ? 'Starting the agent' : 'Working'}
                  </Shimmer>
                )}
              </ConversationContent>
            </Conversation>

            {problem && (
              <Notice tone="danger" title="That did not go through">
                {problem}
              </Notice>
            )}
            {task.ship && (
              <ShipNotice
                approval={task.ship}
                fix={(reason) =>
                  reply.mutate(
                    `Shipping this task did not go through: ${reason} Find the cause, fix it on this branch, and say what you changed.`,
                  )
                }
              />
            )}
            {previewNote && (
              <Notice tone="info" title="Preview deploying">
                {previewNote}
              </Notice>
            )}

            {task.failure ? (
              <div className="mb-6 flex items-center gap-3">
                <span className="flex-1 text-sm text-muted-foreground">
                  A new task starts over with the same prompt.
                </span>
                <Button disabled={restart.isPending} onClick={() => restart.mutate(task.isolated)}>
                  Start a new task
                </Button>
              </div>
            ) : task.status === 'queued' ? (
              <div className="mb-6 flex items-center justify-end gap-3">
                {turns.length === 0 && (
                  <Button
                    variant="outline"
                    disabled={restart.isPending}
                    onClick={() => restart.mutate(true)}
                  >
                    Run on its own
                  </Button>
                )}
                <Button variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>
                  Cancel
                </Button>
              </div>
            ) : (
              <PromptInputProvider>
                <PromptInput className="mb-6" onSubmit={submitting(reply.mutateAsync, true)}>
                  <PromptInputBody>
                    <PromptInputTextarea
                      placeholder={
                        turns.length === 0 && !task.prompt
                          ? 'Prompt'
                          : 'Reply to continue this task…'
                      }
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools />
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
        </TabsContent>
        <TabsContent value="changes" className="mt-2">
          <TaskChanges turns={turns} project={task.project.name} task={task.id} />
        </TabsContent>
        {owned && (
          <TabsContent value="terminal" className="mt-2 pb-6">
            <TaskTerminal task={task.id} />
          </TabsContent>
        )}
        <TabsContent value="files" className="mt-2">
          <TaskFiles project={task.project.name} task={task.id} place={place} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

const taskTabTitle: Record<TaskTab, string> = {
  conversation: 'Conversation',
  changes: 'Changes',
  terminal: 'Terminal',
  files: 'Files',
}

function useOwned(task: Task) {
  const { data: me } = useQuery(meQuery)

  return !!me && me.actor.id === task.owner.id
}

function useOwnerName(task: Task) {
  const { data: me } = useQuery(meQuery)
  const mine = !!me && me.actor.id === task.owner.id
  const { data: members } = useQuery({
    ...membersQuery,
    enabled: !!me && !mine,
    retry: false,
  })

  if (!me) {
    return null
  }

  return mine
    ? 'You'
    : (members?.items.find((member) => member.user_id === task.owner.id)?.name ?? blank)
}

function TaskFacts({ task }: { task: Task }) {
  const by = useOwnerName(task)
  const facts: [string, ReactNode][] = [
    ['Agent', agentLabel(task.agent)],
    ['Model', task.model ? modelLabel(task.model) : blank],
    ['Started', shortAgo(task.created_at)],
    ['By', by ?? blank],
    ['Branch', <Code key="branch">{task.branch}</Code>],
    [
      'Preview',
      task.preview ? (
        <Link
          key="preview"
          {...placeTo(task.project.name, task.preview.name)}
          className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
        >
          <entityIcon.preview className="size-3.5 text-muted-foreground" aria-hidden />
          {task.preview.name}
        </Link>
      ) : (
        <span key="preview" className="text-muted-foreground">
          none
        </span>
      ),
    ],
  ]

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2" data-testid="task-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm">{value}</dd>
        </div>
      ))}
    </dl>
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

const storeProjectSecret = (project: string, name: string, value: string) =>
  send(
    api.v1
      .projects({
        project,
      })
      ['environment-variables'].patch(
        {
          target: 'production',
          set: [
            {
              name,
              kind: 'secret',
              value: value.trim(),
            },
          ],
        },
        idempotency(),
      ),
  )

function FixComposer({ project, target }: { project: string; target: FixTarget | null }) {
  const prefill = useFixPrefill(target)

  if (!target) {
    return <LiveComposer project={project} />
  }

  if (!prefill) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Shimmer className="text-xs">Reading what failed</Shimmer>
      </div>
    )
  }

  return (
    <LiveComposer
      project={prefill.project}
      prefill={{
        prompt: prefill.prompt,
        repository: prefill.repository ?? '',
      }}
    />
  )
}

function LiveComposer(props: {
  project: string | null
  prefill?: { prompt: string; repository: string }
}) {
  const projects = useQuery(projectsQuery)

  if (projects.data?.items.length === 0) {
    return <FirstProject />
  }

  return <Composer {...props} />
}

function FirstProject() {
  const [creating, setCreating] = useState(false)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="font-display text-2xl">Start with a project</h1>
      <p className="max-w-prose text-sm text-muted-foreground">Tasks run inside a project.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setCreating(true)}>
          <Folder /> Create a project
        </Button>
        <Button asChild variant="outline">
          <Link to="/">
            <Rocket /> Open projects
          </Link>
        </Button>
      </div>
      {creating && <NewProject open={creating} onOpenChange={setCreating} />}
    </div>
  )
}

function RepositoryHint({ github }: { github: MyRepositories['github'] | undefined }) {
  if (github !== 'not_connected' && github !== 'reconnect') {
    return null
  }

  return (
    <p className="-mt-3 text-sm text-muted-foreground">
      {github === 'reconnect' ? 'GitHub refused your sign-in. ' : ''}
      <Link to="/account" className="font-medium text-foreground underline underline-offset-4">
        {github === 'reconnect' ? 'Connect GitHub again' : 'Connect GitHub'}
      </Link>{' '}
      to pick a repository, or paste a URL.
    </p>
  )
}

function Composer({
  project: preferred,
  prefill,
}: {
  project: string | null
  prefill?: { prompt: string; repository: string }
}) {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const projects = useProjectList()
  const [project, setProject] = useState(preferred ?? projects[0]?.id ?? '')
  const [agent, setAgent] = useState<WorkspaceAgent>(runnerAgents[0] ?? 'claude')
  const [model, setModel] = useState(workspaceAgents[agent].models[0]?.id ?? '')
  const [repository, setRepository] = useState(prefill?.repository ?? '')
  const reachable = useQuery(myRepositoriesQuery)
  const [secret, setSecret] = useState('')
  const [title, setTitle] = useState('')
  const [isolated, setIsolated] = useState(false)
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const preset = workspaceAgents[agent]
  const url = repositoryUrl(repository)
  const chosen = project || projects[0]?.id || ''
  const tasks = useQuery(tasksQuery)
  const apps = useQuery({
    ...appsQuery(productionOf(chosen)),
    enabled: Boolean(chosen),
  })
  const used = projectRepositories(chosen, tasks.data?.items ?? [], apps.data?.items ?? [])
  const suggestions = [
    ...new Map(
      [
        ...used,
        ...(reachable.data?.items ?? []).map((repo) => repo.clone_url.replace(/\.git$/, '')),
      ].map((value) => [value.toLowerCase(), value]),
    ).values(),
  ]
  const projectVariables = useQuery({
    queryKey: ['environment-variables', 'project', chosen],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project: chosen,
          })
          ['environment-variables'].get(),
      ),
    enabled: Boolean(chosen),
  })
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const myKeys = useQuery({
    queryKey: ['me', 'keys'],
    queryFn: () => unwrap(api.v1.me.keys.get()),
  })
  const keyMissing =
    projectVariables.data !== undefined &&
    myKeys.data !== undefined &&
    !preset.keys.some(
      (key) =>
        projectVariables.data.items.some((item) => item.name === key) ||
        myKeys.data.items.some((item) => item.name === key && item.set),
    )
  const keyChecked = projectVariables.data !== undefined && myKeys.data !== undefined
  const ready = Boolean(url && chosen) && keyChecked && !keyMissing
  const asking =
    blocked?.kind === 'token' ? 'token' : blocked?.kind === 'key' || keyMissing ? 'key' : null
  const [waitingKey, setWaitingKey] = useState<string | null>(null)
  const storeSecret = async () => {
    const value = secret.trim()

    if (!value || !asking || (asking === 'token' && !admin)) {
      return
    }

    if (asking === 'key' && !admin) {
      await unwrap(
        api.v1.me
          .keys({
            name: credentialKey(preset.keys, value),
          })
          .put(
            {
              value,
            },
            idempotency(),
          ),
      )
      void queries.invalidateQueries({
        queryKey: ['me', 'keys'],
      })

      return
    }

    const stored = await storeProjectSecret(
      chosen,
      asking === 'key' ? credentialKey(preset.keys, value) : githubTokenKey,
      value,
    )

    setWaitingKey(stored.waiting ? stored.body.id : null)
    void queries.invalidateQueries({
      queryKey: ['environment-variables', 'project', chosen],
    })
    void queries.invalidateQueries({
      queryKey: ['approvals'],
    })
  }
  const save = useMutation({
    mutationFn: storeSecret,
    onSuccess: () => setSecret(''),
  })
  const start = useMutation({
    mutationFn: async (prompt: string) => {
      await storeSecret()

      return unwrap(
        api.v1.tasks.post(
          {
            project: chosen,
            repository: url!,
            agent,
            model: model || undefined,
            ...taskBrief(prompt, title),
            isolated,
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
      void navigate(taskTo(task.project.name, task.id))
    },
    onError: (error) => {
      setSecret('')
      setBlocked(blockedBy(error))
    },
  })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="font-display text-2xl">New task</h1>
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
            list="live-repositories"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/owner/name"
            aria-invalid={repository !== '' && !url}
          />
          <datalist id="live-repositories">
            {suggestions.map((value) => (
              <option key={value} value={value}>
                {repositoryName(value)}
              </option>
            ))}
          </datalist>
        </div>
      </div>
      {used.length > 0 && (
        <div className="-mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Used in this project</span>
          {used.map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={url?.toLowerCase() === value.toLowerCase() ? 'secondary' : 'outline'}
              aria-pressed={url?.toLowerCase() === value.toLowerCase()}
              onClick={() => setRepository(value)}
            >
              {repositoryName(value)}
            </Button>
          ))}
        </div>
      )}
      <RepositoryHint github={reachable.data?.github} />
      {asking && (
        <Notice
          tone="warning"
          title={
            asking === 'key'
              ? admin
                ? `No ${preset.keyLabel} in this project`
                : `No ${preset.keyLabel}`
              : `${githubTokenLabel} needed`
          }
        >
          <span className="flex flex-col gap-2">
            {asking === 'key'
              ? admin
                ? `${preset.keyHelp} Saved as a secret environment variable.`
                : `${preset.keyHelp} Saved as your own key.`
              : admin
                ? githubTokenHelp
                : 'Stationly cannot read this repository. Connect GitHub, or ask an admin for a token.'}
            {(asking === 'key' || admin) && (
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  save.mutate()
                }}
              >
                <Field
                  id="task-secret"
                  label={asking === 'key' ? preset.keyLabel : githubTokenLabel}
                  className="flex-1"
                  labelClassName="text-foreground"
                >
                  <Input
                    id="task-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    className="bg-background"
                  />
                </Field>
                <Button type="submit" variant="outline" disabled={!secret.trim() || save.isPending}>
                  {save.isPending && <Loader2 className="animate-spin" aria-hidden />}
                  Save
                </Button>
              </form>
            )}
            {save.isError && <span>{failureText(save.error)}</span>}
            {waitingKey && (
              <span>
                Saved. Waits for an admin’s approval.{' '}
                <Link
                  to="/approvals/$approval"
                  params={{
                    approval: waitingKey,
                  }}
                  className="font-medium underline underline-offset-4"
                >
                  Review
                </Link>
              </span>
            )}
          </span>
        </Notice>
      )}
      {(blocked?.kind === 'refused' || blocked?.kind === 'other') && (
        <Notice tone="danger" title="The task did not start">
          {blocked.text}
        </Notice>
      )}
      <PromptInputProvider initialInput={prefill?.prompt}>
        <PromptInput
          id="new-task"
          onSubmit={async ({ text }) => {
            if (!ready || (!text.trim() && !title.trim())) {
              throw new Error('Nothing to send yet')
            }

            await start.mutateAsync(text)
            setTitle('')
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder="Describe the task (optional)" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools className="flex-wrap">
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
              <CheckboxField
                id="new-task-isolated"
                checked={isolated}
                onCheckedChange={setIsolated}
                label="Run on its own"
                className="px-2"
                labelClassName="whitespace-nowrap"
              />
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!ready || start.isPending}
              status={start.isPending ? 'submitted' : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
        <PromptlessTitle value={title} onChange={setTitle} />
      </PromptInputProvider>
      {keyMissing && (
        <p className="text-sm text-muted-foreground">Add the {preset.keyLabel} above to start.</p>
      )}
    </div>
  )
}

const titleLimit = 120

function PromptlessTitle({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const prompt = usePromptInputController().textInput.value

  if (prompt.trim()) {
    return null
  }

  return (
    <Field id="new-task-title" label="Title">
      <Input
        id="new-task-title"
        form="new-task"
        required
        maxLength={titleLimit}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Names the task and its branch"
      />
    </Field>
  )
}

function ShipNotice({ approval, fix }: { approval: ShipApproval; fix: (reason: string) => void }) {
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const status = useShipStatus(approval)
  const state = status.state
  const reason = shipProblem(approval)
  const broken = reason && state !== 'merged' && state !== 'pushing'

  return (
    <Notice tone={broken ? 'danger' : status.tone} title={status.title}>
      <span className="flex flex-col gap-2">
        {reason && <span>{reason}</span>}
        <span className="flex flex-wrap items-center gap-2">
          {state === 'open' && admin ? (
            <ShipDecision approval={approval} />
          ) : (
            <PullRequestLink approval={approval} />
          )}
          <ShipDeployments deployments={status.deployments} />
          {broken && (
            <Button size="sm" variant="outline" onClick={() => fix(reason)}>
              Fix with an agent
            </Button>
          )}
        </span>
      </span>
    </Notice>
  )
}
