import { ChevronRight, CircleAlert, Loader2, TerminalSquare } from 'lucide-react'
import { useMemo, useReducer, useState } from 'react'

import type { AgentEventValue } from '@stationly/protocol'

import { AgentMarkdown } from '@/components/agent-markdown'
import { AgentStatusBadge } from '@/components/agent-status'
import { Code } from '@/components/code'
import { FollowTail } from '@/components/follow-tail'
import { EmptyState } from '@/components/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  applyPart,
  applyStored,
  attentionText,
  emptyAgentState,
  failedCalls,
  runningCalls,
  sessionsOf,
  toolSentence,
  turnsOf,
  type AgentLivePart,
  type AgentState,
  type ToolCall,
  type Turn,
} from '@/lib/agent-session'
import { agentStreamTypes, agentStreamUrl } from '@/lib/agent-stream'
import type { Sandbox } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { ago, duration } from '@/lib/format'
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

  return (
    <Collapsible defaultOpen={failed} className="group/row">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span className={cn('shrink-0 font-medium', failed && toneText.danger)}>{call.name}</span>
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
        {call.output ? (
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
  const running = runningCalls(calls)

  return (
    <Collapsible defaultOpen={failed > 0} className="group/group rounded-md border">
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
      <CollapsibleContent className="border-t px-2.5 py-1">
        {calls.map((call) => (
          <ToolRow key={call.id} call={call} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <section className="space-y-3">
      {turn.prompt !== null && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2">
            <AgentMarkdown text={turn.prompt} />
          </div>
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
          Finished in {duration(turn.startedAt, turn.endedAt)}
        </p>
      )}
    </section>
  )
}

export function AgentTab({
  sandbox,
  onOpenTerminal,
}: {
  sandbox: Sandbox
  onOpenTerminal: () => void
}) {
  const [state, dispatch] = useReducer(reduce, emptyAgentState)
  const [chosen, setChosen] = useState<string | null>(null)
  const claude = sandbox.workspace?.agent === 'claude'
  const stream = useEventStream(claude ? agentStreamUrl(sandbox.id) : null, handlers(dispatch))
  const sessions = useMemo(() => sessionsOf(state.events), [state.events])
  const session = chosen ?? sessions.at(-1)?.id ?? null
  const turns = useMemo(() => (session ? turnsOf(state, session) : []), [state, session])
  const status = sandbox.agent_status ?? null
  const lastAttention = state.events.findLast((event) => event.type === 'attention')

  if (!claude) {
    return (
      <EmptyState
        title="No watch view for this agent yet"
        description="The Agent tab follows Claude Code. This workspace runs another agent, so use the terminal."
        action={
          <Button variant="outline" onClick={onOpenTerminal}>
            <TerminalSquare /> Open terminal
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AgentStatusBadge status={status} announce />
        {status?.last_event_at && (
          <span className="text-xs text-muted-foreground">
            Last event {ago(status.last_event_at)}
          </span>
        )}
        {sessions.length > 1 && session && (
          <Select value={session} onValueChange={setChosen}>
            <SelectTrigger size="sm" aria-label="Session">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {`${item.id.slice(0, 8)} · ${ago(item.startedAt)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Watching only. Reply in the terminal.
          <Button size="sm" variant="outline" onClick={onOpenTerminal}>
            <TerminalSquare /> Open terminal
          </Button>
          <Code copy={`sly sandboxes shell ${sandbox.name}`}>
            {`sly sandboxes shell ${sandbox.name}`}
          </Code>
        </span>
      </div>
      {status?.status === 'waiting' && (
        <Alert className={warningAlert}>
          <CircleAlert />
          <AlertDescription className="text-current">
            {attentionText[status.kind ?? 'permission']}
            {lastAttention?.type === 'attention' && lastAttention.data.tool
              ? ` ${lastAttention.data.tool}${lastAttention.data.summary ? `: ${lastAttention.data.summary}` : ''}.`
              : ''}{' '}
            Answer in the terminal.
          </AlertDescription>
        </Alert>
      )}
      {turns.length ? (
        <FollowTail
          changes={state}
          label="Agent session"
          className="max-h-[65vh] space-y-6 rounded-lg border p-4"
        >
          {turns.map((turn) => (
            <TurnView key={turn.key} turn={turn} />
          ))}
        </FollowTail>
      ) : (
        <EmptyState
          title="No agent session yet"
          description={
            <>
              Start <Code>claude</Code> in the workspace and what it does appears here.
            </>
          }
        />
      )}
      {stream === 'offline' && state.events.length > 0 && (
        <p className="text-xs text-muted-foreground">Disconnected. Reload to follow again.</p>
      )}
    </div>
  )
}
