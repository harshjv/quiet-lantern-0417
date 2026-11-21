import {
  noop,
  queryOptions,
  type QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
} from '@tanstack/react-query'

import { api, unwrap, type App, type Deployment, type Preview } from './api'
import { on, seed, seedItem, type Edit } from './cache'
import { logTail, type LogSelector } from './logs'
import { placeKey, previewQuery, type Place } from './place'
import { isTerminal } from './status'

export const load = <TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  client: QueryClient,
  options: QueryExecuteOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
) =>
  client.query({
    ...options,
    staleTime: 'static',
  })

export const warm = <TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  client: QueryClient,
  options: QueryExecuteOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
) => load(client, options).then(noop, noop)

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => unwrap(api.v1.me.get()),
  staleTime: 60_000,
})

export const membersQuery = queryOptions({
  queryKey: ['members'],
  queryFn: () => unwrap(api.v1.members.get()),
})

export const myRepositoriesQuery = queryOptions({
  queryKey: ['me', 'repositories'],
  queryFn: () => unwrap(api.v1.me.repositories.get()),
  staleTime: 300_000,
})

export const projectsQuery = queryOptions({
  queryKey: ['projects'],
  queryFn: () =>
    unwrap(
      api.v1.projects.get({
        query: {
          limit: 200,
        },
      }),
    ),
})

export const projectQuery = (project: string) =>
  queryOptions({
    queryKey: ['projects', project],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .get({
            query: {},
          }),
      ),
  })

export const canvasProjectQuery = (project: string) =>
  queryOptions({
    queryKey: ['projects', project, 'canvas'],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .get({
            query: {
              fields: 'id,name,waiting_approvals,servers,task_slots,task_egress',
            },
          }),
      ),
    refetchInterval: 15_000,
  })

export const projectSettingsQuery = (project: string) =>
  queryOptions({
    queryKey: ['projects', project, 'settings'],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .get({
            query: {
              fields:
                'id,name,shared,manifest_path,build_cache_bytes,image_retention_count,base_image_auto_rebuild,pull_request_previews',
            },
          }),
      ),
  })

export const previewsQuery = (project: string) =>
  queryOptions({
    queryKey: ['previews', 'of', project],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .previews.get({
            query: {
              limit: 200,
            },
          }),
      ),
  })

export const previewQueryOf = (preview: string) =>
  queryOptions({
    queryKey: ['previews', preview],
    queryFn: () =>
      unwrap(
        api.v1
          .previews({
            preview,
          })
          .get({
            query: {},
          }),
      ),
  })

export const networkQuery = (place: Place) =>
  queryOptions({
    queryKey: ['network', placeKey(place)],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project: place.project,
          })
          .network.get({
            query: previewQuery(place),
          }),
      ),
  })

export const appsQuery = (place: Place) =>
  queryOptions({
    queryKey: ['apps', 'of', placeKey(place)],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project: place.project,
          })
          .apps.get({
            query: {
              ...previewQuery(place),
              limit: 200,
              fields:
                'id,project_id,preview_id,name,kind,status,status_reason,desired_state,source,stale,stale_reasons,current_deployment_id,current_deployment,domains',
            },
          }),
      ),
  })

export const appQuery = (app: string) =>
  queryOptions({
    queryKey: ['apps', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          .get({
            query: {
              fields:
                'id,project_id,preview_id,name,kind,status,status_reason,desired_state,server_id,source,current_deployment_id,stale,stale_reasons,health,health_default,last_health_change,ports,current_deployment,domains',
            },
          }),
      ),
  })

export const deploymentsQuery = (app: string) =>
  queryOptions({
    queryKey: ['deployments', 'of', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          .deployments.get({
            query: {
              limit: 50,
              fields:
                'id,app_id,number,status,trigger,strategy,cancel_reason,started_at,finished_at,failure,image_ref,created_at',
            },
          }),
      ),
  })

export const placeDeploymentsQuery = (place: Place, limit = 10) =>
  queryOptions({
    queryKey: ['deployments', 'in', placeKey(place), limit],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project: place.project,
          })
          .deployments.get({
            query: {
              ...previewQuery(place),
              limit,
              fields: 'id,app_id,number,status,trigger,started_at,finished_at,failure,created_at',
            },
          }),
      ),
  })

export const deploymentQuery = (id: string) =>
  queryOptions({
    queryKey: ['deployments', id],
    queryFn: () =>
      unwrap(
        api.v1
          .deployments({
            id,
          })
          .get({
            query: {
              fields:
                'id,app_id,number,status,trigger,strategy,cancel_reason,started_at,finished_at,failure,image_ref,build_id,created_at,steps,build',
            },
          }),
      ),
    refetchInterval: (query) => (isTerminal(query.state.data?.status) ? false : 2000),
  })

export const diagnosisQuery = (id: string) =>
  queryOptions({
    queryKey: ['deployments', id, 'diagnosis'],
    queryFn: () =>
      unwrap(
        api.v1
          .deployments({
            id,
          })
          .diagnosis.get(),
      ),
  })

export const variablesQuery = (app: string) =>
  queryOptions({
    queryKey: ['environment-variables', 'of', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          ['environment-variables'].get(),
      ),
  })

export const namesQuery = (project: string) =>
  queryOptions({
    queryKey: ['apps', 'names', project],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .apps.get({
            query: {
              limit: 200,
              fields: 'id,name,ports,volumes,domains,environment_variables',
            },
          }),
      ),
  })

export const projectVariablesQuery = (project: string, target: 'production' | 'preview') =>
  queryOptions({
    queryKey: ['environment-variables', 'project', project, target],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          ['environment-variables'].get({
            query: {
              target,
            },
          }),
      ),
  })

export const resolvedQuery = (app: string) =>
  queryOptions({
    queryKey: ['environment-variables', 'resolved', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          ['environment-variables'].resolved.get({
            query: {},
          }),
      ),
    staleTime: 0,
    gcTime: 0,
  })

export const domainsQuery = (app: string) =>
  queryOptions({
    queryKey: ['domains', 'of', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          .domains.get({
            query: {
              fields: 'id,app_port_id,hostname,kind,status,tunnel_route,error',
            },
          }),
      ),
  })

export const portsQuery = (app: string) =>
  queryOptions({
    queryKey: ['ports', 'of', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          .ports.get(),
      ),
  })

export const onlineStationsQuery = queryOptions({
  queryKey: ['stations', 'online'],
  queryFn: () =>
    unwrap(
      api.v1.servers.get({
        query: {
          status: 'online',
          limit: 200,
        },
      }),
    ),
  staleTime: 60_000,
})

export const appMetricsQuery = (app: string) =>
  queryOptions({
    queryKey: ['metrics', app],
    queryFn: () =>
      unwrap(
        api.v1
          .apps({
            app,
          })
          .metrics.get(),
      ),
    refetchInterval: 10_000,
  })

export const logsQuery = (selector: LogSelector) =>
  queryOptions({
    queryKey: ['logs', selector],
    queryFn: () =>
      unwrap(
        api.v1.logs.get({
          query: {
            ...selector,
            tail: logTail,
          },
        }),
      ),
    select: (page) => page.untrusted.lines,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

export const stationsQuery = queryOptions({
  queryKey: ['stations', 'list'],
  queryFn: () =>
    unwrap(
      api.v1.servers.get({
        query: {
          limit: 200,
          fields: 'id,name,status,arch,capabilities,default_machine_runtime,machine_runtime_advice',
        },
      }),
    ),
})

export const inventoryQuery = queryOptions({
  queryKey: ['inventory'],
  queryFn: () => unwrap(api.v1.inventory.get()),
})

export const releasesQuery = queryOptions({
  queryKey: ['platform', 'releases'],
  queryFn: () => unwrap(api.v1.platform.releases.get()),
  staleTime: 300_000,
})

const approvalFields =
  'id,project_id,task_id,title,status,source,requested_by,requester,requester_decides,decided_by,decided_at,self_approved,reason,ship,created_at,summary,changes,refs'

export const approvalsQuery = (status: string) =>
  queryOptions({
    queryKey: ['approvals', 'list', status],
    queryFn: () =>
      unwrap(
        api.v1.approvals.get({
          query: {
            status,
            limit: 100,
            fields: approvalFields,
          },
        }),
      ),
  })

export const projectApprovalsQuery = (project: string) =>
  queryOptions({
    queryKey: ['approvals', 'in', project],
    queryFn: () =>
      unwrap(
        api.v1.approvals.get({
          query: {
            project,
            status: 'all',
            limit: 100,
            fields: approvalFields,
          },
        }),
      ),
  })

export const approvalQuery = (id: string) =>
  queryOptions({
    queryKey: ['approvals', id],
    queryFn: () =>
      unwrap(
        api.v1
          .approvals({
            approval: id,
          })
          .get({
            query: {
              fields: `${approvalFields},deployments`,
            },
          }),
      ),
  })

export const tasksQuery = queryOptions({
  queryKey: ['tasks'],
  queryFn: () =>
    unwrap(
      api.v1.tasks.get({
        query: {
          limit: 200,
        },
      }),
    ),
})

export const projectTasksQuery = (project: string) =>
  queryOptions({
    queryKey: ['tasks', 'in', project],
    queryFn: () =>
      unwrap(
        api.v1.tasks.get({
          query: {
            project,
            limit: 200,
          },
        }),
      ),
  })

export const taskQuery = (task: string) =>
  queryOptions({
    queryKey: ['tasks', task],
    queryFn: () =>
      unwrap(
        api.v1
          .tasks({
            task,
          })
          .get(),
      ),
  })

export const seedPreview = (project: string, preview: Preview) => [
  seed(previewQueryOf(preview.id), preview),
  seedItem(previewsQuery(project), preview),
]

export const seedApp = (app: App) => [seed(appQuery(app.id), app)]

export const seedDeployment = (deployment: Deployment) => [
  seed(deploymentQuery(deployment.id), deployment),
]

export const apiOriginQuery = queryOptions({
  queryKey: ['settings', 'hostnames.api'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.settings.get({
        query: {
          prefix: 'hostnames.api',
        },
      }),
    )
    const host = page.items.find((setting) => setting.key === 'hostnames.api')?.value

    return typeof host === 'string' && host ? `https://${host}` : window.location.origin
  },
  staleTime: 'static',
})

export const agentTokensQuery = queryOptions({
  queryKey: ['tokens', 'agents'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.tokens.get({
        query: {
          kind: 'scoped',
          limit: 200,
        },
      }),
    )

    return page.items.filter((token) => token.name.startsWith('mcp/'))
  },
})

export const personalTokensQuery = queryOptions({
  queryKey: ['tokens', 'personal'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.tokens.get({
        query: {
          kind: 'personal',
          limit: 200,
        },
      }),
    )

    return page.items
  },
})

export const withoutToken = (id: string): Edit[] =>
  [agentTokensQuery, personalTokensQuery].map((query) =>
    on(query, (tokens) => tokens?.filter((t) => t.id !== id)),
  )

export const taskStationQuery = queryOptions({
  queryKey: ['stations', 'online', 'task'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.servers.get({
        query: {
          status: 'online',
          limit: 2,
          fields: 'name,resources,machine_memory',
        },
      }),
    )

    return page.items.length === 1 ? page.items[0]! : null
  },
})
