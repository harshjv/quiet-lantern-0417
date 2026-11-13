import type { AgentSession } from './api'

export type SessionGroup = 'waiting' | 'working' | 'finished'

export const sessionGroupLabel: Record<SessionGroup, string> = {
  waiting: 'Waiting on you',
  working: 'Working',
  finished: 'Finished',
}

const order: SessionGroup[] = ['waiting', 'working', 'finished']

export const sessionGroupOf = (session: Pick<AgentSession, 'status'>): SessionGroup =>
  session.status === 'waiting' ? 'waiting' : session.status === 'working' ? 'working' : 'finished'

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

export const sessionMeta = (
  session: Pick<AgentSession, 'sandbox' | 'agent' | 'project' | 'environment'>,
) =>
  [session.sandbox.name, session.agent, `${session.project.name}/${session.environment.name}`].join(
    ' · ',
  )

export const matchesTitle = (session: Pick<AgentSession, 'title'>, query: string) => {
  const needle = query.trim().toLowerCase()

  return needle === '' || sessionTitle(session).toLowerCase().includes(needle)
}

export const groupSessions = <T extends Pick<AgentSession, 'status' | 'last_event_at'>>(
  sessions: readonly T[],
) =>
  order
    .map((group) => ({
      group,
      label: sessionGroupLabel[group],
      items: sessions
        .filter((session) => sessionGroupOf(session) === group)
        .toSorted((a, b) => b.last_event_at.localeCompare(a.last_event_at)),
    }))
    .filter((entry) => entry.items.length > 0)

export const sessionLink = (session: Pick<AgentSession, 'sandbox' | 'session_id'>) => ({
  sandbox: session.sandbox.id,
  session: session.session_id,
})
