import { queryOptions } from '@tanstack/react-query'

import { api, unwrap, type Station } from '@/lib/api'
import { mergeItem } from '@/lib/cache'
import type { Tone } from '@/lib/tone'

const serverFields = [
  'intermittent',
  'public_address',
  'machine_limits',
  'default_machine_runtime',
  'machine_runtime_advice',
  'machine_memory',
  'hosts_dispatch',
  'generation_failure',
  'capabilities',
  'created_at',
].join(',')

export type ServerView = Station &
  Required<
    Pick<
      Station,
      | 'intermittent'
      | 'machine_limits'
      | 'machine_memory'
      | 'hosts_dispatch'
      | 'generation_failure'
      | 'capabilities'
    >
  >

export const serversQuery = queryOptions({
  queryKey: ['stations', 'servers'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.servers.get({
        query: {
          limit: 200,
          fields: serverFields,
        },
      }),
    )

    return {
      ...page,
      items: page.items as ServerView[],
    }
  },
  refetchInterval: (query) =>
    query.state.data?.items.some((server) => server.status === 'enrolling') ? 3000 : 30_000,
})

export const patchServer = (id: string, data: Partial<ServerView>) => [
  mergeItem(serversQuery, id, data),
]

export const serverStatus: Record<Station['status'], { label: string; tone: Tone }> = {
  online: {
    label: 'Online',
    tone: 'success',
  },
  enrolling: {
    label: 'Waiting to pair',
    tone: 'info',
  },
  offline: {
    label: 'Offline',
    tone: 'danger',
  },
  asleep: {
    label: 'Asleep',
    tone: 'neutral',
  },
}

export const versionSkewText: Record<Exclude<Station['version_skew'], 'ok'>, string> = {
  behind: 'Its stationd is older than the release. It catches up on the next upgrade.',
  ahead: 'Its stationd is newer than the release this instance pins.',
  unsupported: 'Its stationd is too far from the release to take new work. Upgrade it.',
}
