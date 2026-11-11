import { noop, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'

import type { Event as EventRow } from './api'
import { completionOf, completionText, startedByAgent } from './completion'
import { useEventStream } from './event-stream'
import { invalidateGroups, stagedDecided, type Group } from './invalidate'
import { deploymentQuery, serviceQuery } from './queries'

const watched = [
  'deployment.*',
  'build.*',
  'run.*',
  'health.changed',
  'domain.changed',
  'staged_change.*',
  'environment.*',
  'secret.changed',
  'station.*',
  'sandbox.*',
]

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
  'sandbox.deleted',
]

const groupsFor = (event: EventRow): Group[] => {
  if (
    event.type.startsWith('deployment.') ||
    event.type.startsWith('build.') ||
    event.type.startsWith('run.')
  ) {
    return ['deployments']
  }

  if (event.type.startsWith('sandbox.')) {
    return ['sandboxes']
  }

  if (event.type === 'health.changed' || event.type.startsWith('station.')) {
    return ['health']
  }

  if (event.type === 'domain.changed') {
    return ['domains']
  }

  if (event.type.startsWith('staged_change.')) {
    return stagedDecided
  }

  if (event.type.startsWith('environment.')) {
    return ['environments']
  }

  if (event.type === 'secret.changed') {
    return ['variables']
  }

  return []
}

const apply = (client: QueryClient, event: EventRow) => {
  const names = groupsFor(event)

  if (names.length) {
    invalidateGroups(client, names)
  } else if (event.subject.entity) {
    void client.invalidateQueries({
      queryKey: [event.subject.entity],
    })
  }
}

const followed = new Set<string>()

export const follow = (deployment: string) => followed.add(deployment)

type Router = ReturnType<typeof useRouter>

const notify = async (client: QueryClient, router: Router, event: EventRow) => {
  const completion = completionOf(event)

  if (!completion) {
    return
  }

  const params = {
    deployment: completion.deployment,
  }
  const mine = followed.delete(completion.deployment)

  if (
    router.matchRoute({
      to: '/deployments/$deployment',
      params,
    })
  ) {
    return
  }

  const deployment = await client.ensureQueryData(deploymentQuery(completion.deployment))

  if (!mine && !startedByAgent(deployment.trigger)) {
    return
  }

  const service = await client.ensureQueryData(serviceQuery(deployment.service_id))
  const text = completionText(completion, service.name)

  toast[completion.outcome === 'active' ? 'success' : 'error'](text.title, {
    description: text.description,
    action: {
      label: text.action,
      onClick: () =>
        void router.navigate({
          to: '/deployments/$deployment',
          params,
        }),
    },
  })
}

export const useLiveEvents = () => {
  const client = useQueryClient()
  const router = useRouter()
  const onEvent = (event: EventRow) => {
    apply(client, event)
    notify(client, router, event).then(noop, noop)
  }

  return useEventStream(
    `/v1/events?types=${encodeURIComponent(watched.join(','))}`,
    Object.fromEntries(listened.map((type) => [type, onEvent])),
  )
}
