import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleAlert, GitBranch } from 'lucide-react'

import { agentLabel, modelLabel } from '@stationly/protocol'

import { AgentMarkdown } from '@/components/agent-markdown'
import { AgentStatusBadge } from '@/components/agent-status'
import { AgentThread, useAgentSession, WaitingNotice } from '@/components/agent-thread'
import { Code } from '@/components/code'
import { EmptyState } from '@/components/page'
import { ReplyBox } from '@/components/reply-box'
import { TaskSetup } from '@/components/task-setup'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { modelOf } from '@/lib/agent-session'
import { sessionShell, sessionTitle } from '@/lib/agent-sessions'
import type { AgentSession } from '@/lib/api'
import { repositoryName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { sandboxQuery, stationsQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const column = 'mx-auto w-full max-w-3xl px-4'

export function SessionThread({
  session,
  fill,
  own,
}: {
  session: AgentSession
  fill: boolean
  own?: boolean
}) {
  const { state, stream } = useAgentSession(session.sandbox.id, true, session.session_id)
  const { data: sandbox } = useQuery(sandboxQuery(session.sandbox.id))
  const { data: stations } = useQuery(stationsQuery)
  const station = stations?.items.find((item) => item.id === sandbox?.station_id)?.name
  const workspace = sandbox?.workspace
  const model = modelOf(state, session.session_id)
  const neverStarted =
    session.status === 'ended' &&
    state.events.some(
      (event) => event.type === 'session.ended' && event.data.reason === 'process_exited',
    ) &&
    !state.events.some((event) => event.type === 'session.started' || event.type === 'message')
  const firstMessage =
    session.title && !state.events.some((event) => event.type === 'prompt') ? (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2">
          <AgentMarkdown text={session.title} />
        </div>
      </div>
    ) : null
  const shell = sessionShell(session)
  const startedLine = [
    station && `Started on ${station}`,
    agentLabel(session.agent),
    model && modelLabel(model),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', !fill && 'gap-4')}>
      {own ? (
        <p className={cn(column, 'text-xs text-muted-foreground')}>{startedLine}</p>
      ) : (
        <header className={cn(column, 'shrink-0 space-y-2 pt-6 pb-4', fill && 'border-b')}>
          <h1 className="truncate text-xl font-semibold tracking-tight">{sessionTitle(session)}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
            <AgentStatusBadge status={session} announce />
            {station && <span>{station}</span>}
            {workspace && (
              <span className="font-mono text-xs">{repositoryName(workspace.repository)}</span>
            )}
            {workspace?.branch && (
              <Code copy={workspace.branch}>
                <GitBranch className="mr-1 inline size-3" aria-hidden />
                {workspace.branch}
              </Code>
            )}
            <Link
              to="/sandboxes/$sandbox"
              params={{
                sandbox: session.sandbox.id,
              }}
              className="underline-offset-4 hover:underline"
            >
              {session.sandbox.name}
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">{startedLine}</p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            Open a terminal on it
            <Code copy={shell}>{shell}</Code>
          </p>
        </header>
      )}
      {session.status === 'waiting' && (
        <div className={column}>
          <WaitingNotice kind={session.kind} state={state} />
        </div>
      )}
      {neverStarted && (
        <div className={cn(column, 'pt-4')}>
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              The agent exited before it started, so this task did nothing. Start a new task; if it
              happens again, the agent is not installed correctly in this workspace.
            </AlertDescription>
          </Alert>
        </div>
      )}
      {session.setup ? (
        <div className={cn(column, 'space-y-6 py-4', fill && 'min-h-0 flex-1 overflow-y-auto')}>
          {firstMessage}
          <TaskSetup setup={session.setup} session={session} sandbox={sandbox} />
        </div>
      ) : (
        <>
          {firstMessage && <div className={cn(column, 'pt-4')}>{firstMessage}</div>}
          <AgentThread
            state={state}
            stream={stream}
            session={session.session_id}
            className={cn(column, 'space-y-6 py-4', fill ? 'h-full' : 'max-h-[70vh]')}
            frameClassName={fill ? 'min-h-0 flex-1' : undefined}
            empty={
              neverStarted ? null : (
                <EmptyState
                  icon={entityIcon.session}
                  title="Waiting for the agent"
                  description="Your message is on its way. The agent's reply appears here."
                />
              )
            }
          />
        </>
      )}
      <div className={cn(column, 'shrink-0 pb-4')}>
        <ReplyBox session={session} sandbox={sandbox} model={model} />
      </div>
    </div>
  )
}
