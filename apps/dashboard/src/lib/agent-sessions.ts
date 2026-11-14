import type { AgentSession } from './api.ts'
import { commands } from './commands.ts'

export type SessionGroup = 'waiting' | 'today' | 'yesterday' | 'earlier' | 'ended'

export const sessionGroupLabel: Record<SessionGroup, string> = {
  waiting: 'Waiting on you',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
  ended: 'Ended',
}

const order: SessionGroup[] = ['waiting', 'today', 'yesterday', 'earlier', 'ended']

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

export const sessionGroupOf = (
  session: Pick<AgentSession, 'status' | 'last_event_at'>,
  now: Date,
): SessionGroup => {
  if (session.status === 'waiting' || session.status === 'ready') {
    return 'waiting'
  }

  if (session.status === 'ended' || session.status === 'failed') {
    return 'ended'
  }

  const days = Math.round(
    (dayStart(now).getTime() - dayStart(new Date(session.last_event_at)).getTime()) / 86_400_000,
  )

  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : 'earlier'
}

export const sessionTitle = (session: Pick<AgentSession, 'title'>) =>
  session.title ?? 'Untitled session'

const kindReason = {
  permission: 'Approve a tool call',
  question: 'Question',
  plan: 'Approve a plan',
} as const

export const sessionReason = (session: Pick<AgentSession, 'status' | 'kind'>) => {
  if (session.status === 'waiting') {
    return kindReason[session.kind ?? 'permission']
  }

  if (session.status === 'ready') {
    return 'Finished, waiting for your reply'
  }

  return session.status === 'failed' ? 'Turn failed' : null
}

export const sessionPlace = (
  session: Pick<AgentSession, 'sandbox' | 'agent' | 'project' | 'environment'>,
) =>
  `${session.sandbox.name} · ${session.agent} · ${session.project.name}/${session.environment.name}`

export const sessionShell = (session: Pick<AgentSession, 'sandbox' | 'project' | 'environment'>) =>
  commands.openWorkspace(
    {
      project: session.project.name,
      environment: session.environment.name,
    },
    session.sandbox.name,
  )

export const matchesTitle = (session: Pick<AgentSession, 'title'>, query: string) => {
  const needle = query.trim().toLowerCase()

  return needle === '' || sessionTitle(session).toLowerCase().includes(needle)
}

const blockedRank = (session: Pick<AgentSession, 'status'>) =>
  session.status === 'waiting' ? 0 : 1

export const groupSessions = <T extends Pick<AgentSession, 'status' | 'last_event_at'>>(
  sessions: readonly T[],
  now: Date,
) =>
  order
    .map((group) => ({
      group,
      label: sessionGroupLabel[group],
      items: sessions
        .filter((session) => sessionGroupOf(session, now) === group)
        .toSorted(
          (a, b) =>
            blockedRank(a) - blockedRank(b) || b.last_event_at.localeCompare(a.last_event_at),
        ),
    }))
    .filter((entry) => entry.items.length > 0)

export const topSession = <T extends Pick<AgentSession, 'status' | 'last_event_at'>>(
  sessions: readonly T[],
  now: Date,
) => {
  const groups = groupSessions(sessions, now)

  return (
    groups.find((entry) => entry.group === 'waiting')?.items[0] ??
    sessions.toSorted((a, b) => b.last_event_at.localeCompare(a.last_event_at))[0]
  )
}

export const sessionLink = (session: Pick<AgentSession, 'sandbox' | 'session_id'>) => ({
  sandbox: session.sandbox.id,
  session: session.session_id,
})
