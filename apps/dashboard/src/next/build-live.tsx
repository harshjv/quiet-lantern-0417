import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Clock, ExternalLink, Eye, Folder, GitBranch, Rocket, Share2 } from 'lucide-react'
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
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { api, ApiFailure, failureText, idempotency, send, unwrap, type Task } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { plural, repositoryName, shortAgo } from '@/lib/format'
import {
  credentialKey,
  githubTokenHelp,
  githubTokenKey,
  githubTokenLabel,
  githubTokenRefused,
  needsGithubToken,
  repositoryUrl,
} from '@/lib/new-task'
import { meQuery, tasksQuery } from '@/lib/queries'
import { setupFailure } from '@/lib/setup-failure'
import { toneText } from '@/lib/tone'

import type { Place } from './app'
import { TaskMenu } from './build-task'
import { asRow, useProjectList } from './data'
import { fixTarget, useFixPrefill, type FixTarget } from './fix-live'
import { taskTone } from './fixtures'
import { AgentSays, Checklist, Meta, Notice, StatusPill, type Step } from './parts'
import { PullRequestLink, ShipDecision, shipStatusText, type ShipRequest } from './ship-request'

type Go = (next: Partial<Place>) => void

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

  if (place.view === 'fix') {
    return <FixComposer target={fixTarget(place.fix ?? null)} go={go} />
  }

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
        title={call.summary.split('\n', 1)[0]}
        state={toolState[call.state]}
      />
      <ToolContent className="flex flex-col gap-3 p-3">
        <pre className="bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">
          {call.summary}
        </pre>
        {call.output ? (
          <ToolOutput
            output={call.state === 'failed' ? undefined : call.output}
            errorText={call.state === 'failed' ? call.output : undefined}
          />
        ) : (
          <p className="font-mono text-xs text-muted-foreground">
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
      <p className="font-mono text-xs text-muted-foreground">
        Retrying after an API error{data.attempt ? ` (attempt ${data.attempt})` : ''}
      </p>
    )
  }

  return (
    <Shimmer className="font-mono text-xs">
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
        <span className="font-medium">Claude asks to use {item.tool}</span>
        {item.status === 'pending' && (
          <span className="font-mono text-xs text-muted-foreground">Waits until {until}</span>
        )}
      </div>
      <pre className="max-h-64 overflow-auto bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
        {approvalBody(item)}
      </pre>
      {item.truncated && (
        <p className={`text-xs ${toneText.warning}`}>
          Cut to fit: the agent asks to run more than this shows. Deny it and ask for a smaller step
          if you cannot tell what it does.
        </p>
      )}
      {item.status !== 'pending' ? (
        <p className="font-mono text-xs text-muted-foreground">
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
      {item.summary && (
        <pre className="max-h-40 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {item.summary}
        </pre>
      )}
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

type ChangesItem = Extract<Turn['items'][number], { kind: 'changes' }>

const changesLine = (item: ChangesItem) => {
  const count = item.files.length + item.moreFiles
  const added = item.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = item.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)

  return [
    count ? `${plural(count, 'file')} changed, +${added} −${removed}` : null,
    item.commits.length ? plural(item.commits.length, 'commit') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function ChangesView({ item }: { item: ChangesItem }) {
  return (
    <details className="border border-border text-sm">
      <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-muted-foreground">
        {changesLine(item)}
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        {item.commits.map((commit) => (
          <p key={commit.sha} className="font-mono text-xs">
            <span className="text-muted-foreground">{commit.sha.slice(0, 7)}</span> {commit.subject}
          </p>
        ))}
        {item.files.map((file) => (
          <details key={file.path}>
            <summary className="cursor-pointer font-mono text-xs">
              {file.path}{' '}
              <span className="text-muted-foreground">
                {file.added === null ? 'binary' : `+${file.added} −${file.removed}`}
              </span>
            </summary>
            {file.diff ? (
              <pre className="mt-1 max-h-72 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre">
                {file.diff}
              </pre>
            ) : null}
          </details>
        ))}
        {item.moreFiles > 0 && (
          <p className="text-xs text-muted-foreground">
            {plural(item.moreFiles, 'more file')} not listed.
          </p>
        )}
        {item.truncated && (
          <p className="text-xs text-muted-foreground">
            Some diffs are cut. Run git diff in the task's worktree for the whole change.
          </p>
        )}
      </div>
    </details>
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
          <p key={item.id} className="font-mono text-xs text-muted-foreground">
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
      {turn.stopped && <p className="font-mono text-xs text-muted-foreground">Stopped</p>}
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
      setPreviewNote(
        `Deploying this task's worktree to ${made.environment.name}${made.url ? ` at ${made.url}` : ''}. It takes a few minutes to build.`,
      )
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
      go({
        view: 'new',
      })
    },
    onError: (error) => setProblem(failureText(error)),
  })
  const restart = useMutation({
    mutationFn: async (machine?: 'own') => {
      const next = await unwrap(
        api.v1.tasks.post(
          {
            project: task.project.id,
            repository: task.repository,
            base_branch: task.base_branch ?? undefined,
            agent: task.agent,
            model: task.model ?? undefined,
            prompt: task.prompt ?? task.title,
            ...(machine
              ? {
                  machine,
                }
              : {}),
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
        {task.preview?.url && (
          <Button asChild variant="outline" size="sm">
            <a href={task.preview.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Preview
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
        {task.ship?.status !== 'merged' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={ship.isPending || task.ship?.status === 'pushing'}
            onClick={() => ship.mutate()}
          >
            <Rocket /> {task.ship ? 'Ship again' : 'Ship it'}
          </Button>
        )}
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
            <TurnView key={turn.key} turn={turn} actions={actions} />
          ))}
          {unseen.map((item) => (
            <Message key={`sent-${item.place}`} from="user">
              <MessageContent>{item.text}</MessageContent>
            </Message>
          ))}
          {progress && <ProgressView progress={progress} />}
          {busy && (
            <Shimmer className="font-mono text-xs">
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
          request={task.ship}
          fix={(reason) =>
            reply.mutate(
              `Shipping this task did not go through: ${reason} Find the cause, fix it on this branch, and say what you changed.`,
            )
          }
        />
      )}
      {previewNote && (
        <Notice tone="info" title="Preview on its way">
          {previewNote}
        </Notice>
      )}

      {task.failure ? (
        <div className="mb-6 flex items-center gap-3">
          <span className="flex-1 text-sm text-muted-foreground">
            This task cannot continue. A new task starts over with the same prompt.
          </span>
          <Button disabled={restart.isPending} onClick={() => restart.mutate(undefined)}>
            Start a new task
          </Button>
        </div>
      ) : task.status === 'queued' ? (
        <div className="mb-6 flex items-center gap-3">
          <span className="flex-1 text-sm text-muted-foreground">
            Every slot on this project's machine is busy. This task starts when one frees
            {task.queued_ahead ? `, after ${task.queued_ahead} more` : ''}.
          </span>
          {turns.length === 0 && (
            <Button
              variant="outline"
              disabled={restart.isPending}
              onClick={() => restart.mutate('own')}
            >
              Run on its own machine
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

function FixComposer({ target, go }: { target: FixTarget | null; go: Go }) {
  const prefill = useFixPrefill(target)

  if (!target) {
    return <LiveComposer project={null} go={go} />
  }

  if (!prefill) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Shimmer className="font-mono text-xs">Reading what failed</Shimmer>
      </div>
    )
  }

  return (
    <LiveComposer
      project={prefill.project}
      go={go}
      prefill={{
        prompt: prefill.prompt,
        repository: prefill.repository ?? '',
      }}
    />
  )
}

function LiveComposer({
  project: preferred,
  go,
  prefill,
}: {
  project: string | null
  go: Go
  prefill?: { prompt: string; repository: string }
}) {
  const queries = useQueryClient()
  const projects = useProjectList()
  const [project, setProject] = useState(preferred ?? projects[0]?.id ?? '')
  const [agent, setAgent] = useState<WorkspaceAgent>(runnerAgents[0] ?? 'claude')
  const [model, setModel] = useState(workspaceAgents[agent].models[0]?.id ?? '')
  const [repository, setRepository] = useState(prefill?.repository ?? '')
  const reachable = useQuery({
    queryKey: ['me', 'repositories'],
    queryFn: () => unwrap(api.v1.me.repositories.get()),
    staleTime: 300_000,
  })
  const [secret, setSecret] = useState('')
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const preset = workspaceAgents[agent]
  const url = repositoryUrl(repository)
  const chosen = project || projects[0]?.id || ''
  const projectKeys = useQuery({
    queryKey: ['variables', 'project', chosen],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project: chosen,
          })
          .variables.get(),
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
    projectKeys.data !== undefined &&
    myKeys.data !== undefined &&
    !preset.keys.some(
      (key) =>
        projectKeys.data.items.some((item) => item.key === key) ||
        myKeys.data.items.some((item) => item.name === key && item.set),
    )
  const asking =
    blocked?.kind === 'token' ? 'token' : blocked?.kind === 'key' || keyMissing ? 'key' : null
  const start = useMutation({
    mutationFn: async (prompt: string) => {
      if (asking === 'key' && secret.trim()) {
        if (admin) {
          await storeProjectKey(chosen, credentialKey(preset.keys, secret), secret)
        } else {
          await unwrap(
            api.v1.me
              .keys({
                name: credentialKey(preset.keys, secret),
              })
              .put(
                {
                  value: secret,
                },
                idempotency(),
              ),
          )
          void queries.invalidateQueries({
            queryKey: ['me', 'keys'],
          })
        }

        void queries.invalidateQueries({
          queryKey: ['variables', 'project', chosen],
        })
      }

      if (asking === 'token' && admin && secret.trim()) {
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
            list="live-repositories"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/owner/name"
            aria-invalid={repository !== '' && !url}
          />
          <datalist id="live-repositories">
            {(reachable.data?.items ?? []).map((repo) => (
              <option key={repo.full_name} value={repo.clone_url.replace(/\.git$/, '')}>
                {repo.full_name}
              </option>
            ))}
          </datalist>
        </div>
      </div>
      {asking && (
        <Notice
          tone="warning"
          title={
            asking === 'key'
              ? admin
                ? `${chosen} has no ${preset.keyLabel}`
                : `You have no ${preset.keyLabel}`
              : `${githubTokenLabel} needed`
          }
        >
          <span className="flex flex-col gap-2">
            {asking === 'key'
              ? admin
                ? `${preset.keyHelp} Stationly stores it sealed for the whole project.`
                : `${preset.keyHelp} Stationly stores it sealed as your own key; only your tasks use it.`
              : admin
                ? githubTokenHelp(chosen, repositoryName(url ?? repository))
                : 'Stationly cannot read this repository. Connect GitHub in Your account with an account that can, or ask an admin for a project token.'}
            {(asking === 'key' || admin) && (
              <Input
                type="password"
                aria-label={asking === 'key' ? preset.keyLabel : githubTokenLabel}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
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

const shipTone: Record<ShipRequest['status'], 'info' | 'warning' | 'danger' | 'success'> = {
  pushing: 'info',
  pending: 'warning',
  rejected: 'danger',
  merged: 'success',
  failed: 'danger',
}

function ShipNotice({ request, fix }: { request: ShipRequest; fix: (reason: string) => void }) {
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const broken = request.reason && request.status !== 'merged' && request.status !== 'pushing'

  return (
    <Notice
      tone={broken ? 'danger' : shipTone[request.status]}
      title={shipStatusText[request.status]}
    >
      <span className="flex flex-col gap-2">
        {request.reason && <span>{request.reason}</span>}
        <span className="flex flex-wrap items-center gap-2">
          {request.status === 'pending' && admin ? (
            <ShipDecision request={request} />
          ) : (
            <PullRequestLink request={request} />
          )}
          {broken && (
            <Button size="sm" variant="outline" onClick={() => fix(request.reason!)}>
              Fix with an agent
            </Button>
          )}
        </span>
      </span>
    </Notice>
  )
}
