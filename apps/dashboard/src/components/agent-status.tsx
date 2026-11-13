import type { AgentStatusRecord } from '@stationly/protocol'

import { useNow } from '@/components/sandbox-clock'
import { StatusBadge } from '@/components/status'
import { agentStatusView } from '@/lib/agent-session'

export function AgentStatusBadge({
  status,
  announce,
}: {
  status:
    | (Pick<AgentStatusRecord, 'status' | 'last_event_at'> &
        Partial<Pick<AgentStatusRecord, 'agents'>>)
    | null
    | undefined
  announce?: boolean
}) {
  const now = useNow(30_000)
  const view = agentStatusView(status, new Date(now))

  return (
    <>
      <StatusBadge
        status={{
          label: view.label,
          tone: view.tone,
        }}
        busy={view.pulse}
      />
      {announce && (
        <span className="sr-only" role="status" aria-live="polite">
          {status?.status === 'waiting' ? view.label : ''}
        </span>
      )}
    </>
  )
}
