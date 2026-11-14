import { useQuery } from '@tanstack/react-query'
import { ChevronRight, CircleAlert, Loader2 } from 'lucide-react'
import { useMemo, useReducer, type ReactNode } from 'react'

import type { AgentEventValue } from '@stationly/protocol'

import { AgentMarkdown } from '@/components/agent-markdown'
import { FollowTail } from '@/components/follow-tail'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  applyPart,
  applyStored,
  attentionText,
  deniedCalls,
  emptyAgentState,
  failedCalls,
  runningCalls,
  toolSentence,
  turnsOf,
  type AgentLivePart,
  type AgentState,
  type ToolCall,
  type Turn,
} from '@/lib/agent-session'
import { agentStreamTypes, agentStreamUrl } from '@/lib/agent-stream'
import { useEventStream } from '@/lib/event-stream'
import { duration } from '@/lib/format'
import { meQuery } from '@/lib/queries'
import { toneText, warningAlert } from '@/lib/tone'
import { cn } from '@/lib/utils'

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
  ) as Parameters<typeof useEventStream<Record<string, unknown>>>[1]

function ToolRow({ call }: { call: ToolCall }) {
  const failed = call.state === 'failed'
  const denied = call.state === 'denied'

  return (
    <Collapsible defaultOpen={failed} className="group/row">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span
          className={cn(
            'shrink-0 font-medium',
            failed && toneText.danger,
            denied && toneText.warning,
          )}
        >
          {call.name}
        </span>
        {denied && <span className={cn('shrink-0 text-xs', toneText.warning)}>Denied</span>}
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {call.summary}
        </code>
        {call.state === 'running' && (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-label="Running"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-2 pl-5.5">
        {denied ? (
          <p className="text-xs text-muted-foreground">
            This session runs in auto mode and cannot ask, so the agent was told no and carried on.
          </p>
        ) : call.output ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {call.output}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">Output not stored.</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const failed = failedCalls(calls)
  const denied = deniedCalls(calls)
  const running = runningCalls(calls)

  return (
    <Collapsible
      defaultOpen={failed > 0 || denied > 0}
      className="group/group rounded-md bg-muted/40"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/group:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span>{toolSentence(calls)}</span>
        {running > 0 && (
          <Loader2
            className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-label="Running"
          />
        )}
        {failed > 0 && <span className={toneText.danger}>{failed} failed</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 py-1">
        {calls.map((call) => (
          <ToolRow key={call.id} call={call} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function TurnView({ turn, index }: { turn: Turn; index: number }) {
  const { data: me } = useQuery(meQuery)
  const sender = turn.by && me && turn.by.id !== me.actor.id ? turn.by.id : null

  return (
    <section className="space-y-3">
      {turn.prompt !== null && (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2">
            <AgentMarkdown text={turn.prompt} />
          </div>
          {sender && <span className="text-xs text-muted-foreground">Sent by {sender}</span>}
        </div>
      )}
      {turn.items.map((item) =>
        item.kind === 'tools' ? (
          <ToolGroup key={item.id} calls={item.calls} />
        ) : (
          <AgentMarkdown
            key={`${item.kind}-${item.id}`}
            text={item.text}
            className={item.kind === 'live' ? 'opacity-70' : undefined}
          />
        ),
      )}
      {turn.failure && (
        <p className={cn('text-sm', toneText.danger)}>Turn failed: {turn.failure}</p>
      )}
      {turn.endedAt && !turn.failure && turn.startedAt && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {duration(turn.startedAt, turn.endedAt)} · turn {index + 1}
        </p>
      )}
    </section>
  )
}

export function useAgentSession(sandboxId: string, enabled: boolean, session?: string) {
  const [state, dispatch] = useReducer(reduce, emptyAgentState)
  const stream = useEventStream(
    enabled ? agentStreamUrl(sandboxId, session) : null,
    handlers(dispatch),
  )

  return {
    state,
    stream,
  }
}

export function WaitingNotice({
  kind,
  state,
}: {
  kind: keyof typeof attentionText | null
  state: AgentState
}) {
  const lastAttention = state.events.findLast((event) => event.type === 'attention')

  return (
    <Alert className={warningAlert}>
      <CircleAlert />
      <AlertDescription className="text-current">
        {attentionText[kind ?? 'permission']}
        {lastAttention?.type === 'attention' && lastAttention.data.tool
          ? ` ${lastAttention.data.tool}${lastAttention.data.summary ? `: ${lastAttention.data.summary}` : ''}.`
          : ''}{' '}
        Answer in the terminal.
      </AlertDescription>
    </Alert>
  )
}

export function AgentThread({
  state,
  stream,
  session,
  empty,
  frameClassName,
  className = 'space-y-6',
}: {
  state: AgentState
  stream: ReturnType<typeof useEventStream>
  session: string | null
  empty: ReactNode
  frameClassName?: string
  className?: string
}) {
  const turns = useMemo(() => (session ? turnsOf(state, session) : []), [state, session])

  return (
    <>
      {turns.length ? (
        <FollowTail
          changes={state}
          label="Agent session"
          className={className}
          frameClassName={frameClassName}
        >
          {turns.map((turn, index) => (
            <TurnView key={turn.key} turn={turn} index={index} />
          ))}
        </FollowTail>
      ) : (
        empty
      )}
      {stream === 'offline' && state.events.length > 0 && (
        <p className="text-xs text-muted-foreground">Disconnected. Reload to follow again.</p>
      )}
    </>
  )
}
