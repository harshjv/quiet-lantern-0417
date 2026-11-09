import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Event as EventRow } from './api'

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

const keysFor = (event: EventRow): string[][] => {
  const { subject } = event
  if (event.type.startsWith('deployment.') || event.type.startsWith('build.') || event.type.startsWith('run.')) {
    return [['deployments'], ['services'], ['projects'], ['environments']]
  }
  if (event.type.startsWith('sandbox.')) return [['sandboxes'], ['sandbox-snapshots']]
  if (event.type === 'health.changed') return [['services'], ['projects']]
  if (event.type === 'domain.changed') return [['domains'], ['network']]
  if (event.type.startsWith('staged_change.')) return [['staged'], ['environments'], ['services'], ['variables'], ['domains'], ['deployments'], ['projects']]
  if (event.type.startsWith('environment.')) return [['environments'], ['projects']]
  if (event.type === 'secret.changed') return [['variables'], ['services']]
  if (event.type.startsWith('station.')) return [['services']]
  return subject.entity ? [[subject.entity]] : []
}

const apply = (client: QueryClient, event: EventRow) => {
  for (const queryKey of keysFor(event)) void client.invalidateQueries({ queryKey })
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
