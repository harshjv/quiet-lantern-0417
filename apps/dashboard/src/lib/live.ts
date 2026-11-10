import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Event as EventRow } from './api'
import { invalidateGroups, stagedDecided, type Group } from './invalidate'

export type LiveState = 'connecting' | 'live' | 'offline'

const watched = ['deployment.*', 'build.*', 'run.*', 'health.changed', 'domain.changed', 'staged_change.*', 'environment.*', 'secret.changed', 'station.*', 'sandbox.*']

const listened = [
  'deployment.started',
  'deployment.active',
  'deployment.failed',
  'deployment.cancelled',
  'build.finished',
  'run.failed',
  'health.changed',
  'domain.changed',
  'staged_change.created',
  'staged_change.accepted',
  'staged_change.rejected',
  'environment.created',
  'environment.deleted',
  'secret.changed',
  'station.online',
  'station.offline',
  'station.drift',
  'station.asleep',
  'sandbox.started',
  'sandbox.stopped',
  'sandbox.failed',
  'sandbox.deleted'
]

const groupsFor = (event: EventRow): Group[] => {
  if (event.type.startsWith('deployment.') || event.type.startsWith('build.') || event.type.startsWith('run.')) return ['deployments']
  if (event.type.startsWith('sandbox.')) return ['sandboxes']
  if (event.type === 'health.changed' || event.type.startsWith('station.')) return ['health']
  if (event.type === 'domain.changed') return ['domains']
  if (event.type.startsWith('staged_change.')) return stagedDecided
  if (event.type.startsWith('environment.')) return ['environments']
  if (event.type === 'secret.changed') return ['variables']
  return []
}

const apply = (client: QueryClient, event: EventRow) => {
  const names = groupsFor(event)
  if (names.length) invalidateGroups(client, names)
  else if (event.subject.entity) void client.invalidateQueries({ queryKey: [event.subject.entity] })
}

export const useLiveEvents = () => {
  const client = useQueryClient()
  const [state, setState] = useState<LiveState>('connecting')
  useEffect(() => {
    const source = new EventSource(`/v1/events?types=${encodeURIComponent(watched.join(','))}`)
    const onEvent = (message: MessageEvent<string>) => {
      try {
        apply(client, JSON.parse(message.data) as EventRow)
      } catch {
        return
      }
    }
    for (const type of listened) source.addEventListener(type, onEvent)
    source.onopen = () => setState('live')
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
    return () => source.close()
  }, [client])
  return state
}
