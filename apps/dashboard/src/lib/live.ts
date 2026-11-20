import { noop, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'

import type { Event as EventRow } from './api'
import { completionOf, completionText, startedByAgent } from './completion'
import { useEventStream } from './event-stream'
import { approvalDecided, invalidateGroups, type Group } from './invalidate'
import { appQuery, deploymentQuery } from './queries'

const watched = [
  'deployment.*',
  'build.*',
  'run.*',
  'health.changed',
  'domain.changed',
  'approval.*',
  'preview.*',
  'secret.changed',
  'server.*',
  'machine.*',
  'task.*',
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
  'approval.created',
  'approval.approved',
  'approval.rejected',
  'preview.created',
  'preview.deleted',
  'secret.changed',
  'server.online',
  'server.offline',
  'server.drift',
  'server.asleep',
  'machine.started',
  'machine.stopped',
  'machine.failed',
  'machine.deleted',
  'task.created',
  'task.changed',
  'task.deleted',
]

const groupsFor = (event: EventRow): Group[] => {
  if (
    event.type.startsWith('deployment.') ||
    event.type.startsWith('build.') ||
    event.type.startsWith('run.')
  ) {
    return ['deployments']
  }

  if (event.type.startsWith('machine.')) {
    return ['machines']
  }

  if (event.type.startsWith('task.')) {
    return ['tasks']
  }

  if (event.type === 'health.changed' || event.type.startsWith('server.')) {
    return ['health']
  }

  if (event.type === 'domain.changed') {
    return ['domains']
  }

  if (event.type.startsWith('approval.')) {
    return approvalDecided
  }

  if (event.type.startsWith('preview.')) {
    return ['previews']
  }

  if (event.type === 'secret.changed') {
    return ['environment-variables']
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

const notify = async (
  client: QueryClient,
  router: ReturnType<typeof useRouter>,
  event: EventRow,
) => {
  const completion = completionOf(event)

  if (!completion) {
    return
  }

  const here = {
    to: '/deployments/$deployment',
    params: {
      deployment: completion.deployment,
    },
  } as const
  const mine = followed.delete(completion.deployment)

  if (router.matchRoute(here)) {
    return
  }

  const deployment = await client.ensureQueryData(deploymentQuery(completion.deployment))

  if (!mine && !startedByAgent(deployment.trigger)) {
    return
  }

  const app = await client.ensureQueryData(appQuery(deployment.app_id))
  const text = completionText(completion, app.name)

  toast[completion.outcome === 'active' ? 'success' : 'error'](text.title, {
    description: text.description,
    action: {
      label: text.action,
      onClick: () => void router.navigate(here),
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
