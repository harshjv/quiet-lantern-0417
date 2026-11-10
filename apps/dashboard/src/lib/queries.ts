import { queryOptions } from '@tanstack/react-query'

import { api, unwrap } from './api'
import { isTerminal, isTransient, snapshotsBusy } from './status'

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => unwrap(api.v1.me.get()),
  staleTime: 60_000,
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

export const environmentsQuery = (project: string) =>
  queryOptions({
    queryKey: ['environments', 'of', project],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .environments.get({
            query: {
              limit: 200,
            },
          }),
      ),
  })

export const environmentQuery = (environment: string) =>
  queryOptions({
    queryKey: ['environments', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          .get({
            query: {},
          }),
      ),
  })

export const networkQuery = (environment: string) =>
  queryOptions({
    queryKey: ['network', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          .network.get({
            query: {},
          }),
      ),
  })

export const servicesQuery = (environment: string) =>
  queryOptions({
    queryKey: ['services', 'of', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          .services.get({
            query: {
              limit: 200,
              fields:
                'id,name,kind,status,status_reason,desired_state,source,stale,stale_reasons,current_deployment_id,current_deployment,domains',
            },
          }),
      ),
  })

export const serviceQuery = (service: string) =>
  queryOptions({
    queryKey: ['services', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .get({
            query: {
              fields:
                'id,environment_id,name,kind,status,status_reason,desired_state,station_id,source,current_deployment_id,stale,stale_reasons,current_deployment',
            },
          }),
      ),
  })

export const deploymentsQuery = (service: string) =>
  queryOptions({
    queryKey: ['deployments', 'of', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .deployments.get({
            query: {
              limit: 50,
              fields:
                'id,service_id,number,status,trigger,strategy,cancel_reason,started_at,finished_at,failure,image_ref,created_at',
            },
          }),
      ),
  })

export const environmentDeploymentsQuery = (environment: string) =>
  queryOptions({
    queryKey: ['deployments', 'in', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          .deployments.get({
            query: {
              limit: 10,
              fields:
                'id,service_id,number,status,trigger,started_at,finished_at,failure,created_at',
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
                'id,service_id,number,status,trigger,strategy,cancel_reason,started_at,finished_at,failure,image_ref,build_id,created_at,steps,build',
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

export const variablesQuery = (service: string) =>
  queryOptions({
    queryKey: ['variables', 'of', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .variables.get(),
      ),
  })

export const projectVariablesQuery = (project: string, environment: string) =>
  queryOptions({
    queryKey: ['variables', 'project', project, environment],
    queryFn: () =>
      unwrap(
        api.v1
          .projects({
            project,
          })
          .variables.get({
            query: {
              environment,
            },
          }),
      ),
  })

export const resolvedQuery = (service: string) =>
  queryOptions({
    queryKey: ['variables', 'resolved', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .variables.resolved.get({
            query: {},
          }),
      ),
    staleTime: 0,
    gcTime: 0,
  })

export const domainsQuery = (service: string) =>
  queryOptions({
    queryKey: ['domains', 'of', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .domains.get({
            query: {
              fields:
                'id,service_port_id,hostname,kind,ingress,status,certificate,dns_instructions,error',
            },
          }),
      ),
  })

export const portsQuery = (service: string) =>
  queryOptions({
    queryKey: ['ports', 'of', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .ports.get(),
      ),
  })

export const allocationsQuery = (service: string) =>
  queryOptions({
    queryKey: ['port-allocations', 'of', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          ['port-allocations'].get({
            query: {
              status: 'active',
            },
          }),
      ),
  })

export const sandboxStationQuery = queryOptions({
  queryKey: ['stations', 'online', 'sandbox_memory'],
  queryFn: async () => {
    const page = await unwrap(
      api.v1.stations.get({
        query: {
          status: 'online',
          limit: 2,
          fields: 'sandbox_memory',
        },
      }),
    )
    return page.items.length === 1 ? page.items[0]! : null
  },
})

export const onlineStationsQuery = queryOptions({
  queryKey: ['stations', 'online'],
  queryFn: () =>
    unwrap(
      api.v1.stations.get({
        query: {
          status: 'online',
          limit: 200,
        },
      }),
    ),
  staleTime: 60_000,
})

export const connectionsQuery = (service: string) =>
  queryOptions({
    queryKey: ['connections', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          .connections.get({
            query: {},
          }),
      ),
    staleTime: Infinity,
    retry: false,
  })

export const dnsLogQuery = (service: string) =>
  queryOptions({
    queryKey: ['dns-log', service],
    queryFn: () =>
      unwrap(
        api.v1
          .services({
            service,
          })
          ['dns-log'].get({
            query: {
              tail: 50,
            },
          }),
      ),
    staleTime: Infinity,
    retry: false,
  })

export const stationQuery = (station: string) =>
  queryOptions({
    queryKey: ['stations', station],
    queryFn: () =>
      unwrap(
        api.v1
          .stations({
            station,
          })
          .get({
            query: {
              fields: 'id,name,public_address',
            },
          }),
      ),
    retry: false,
  })

export const stagedQuery = (status: string) =>
  queryOptions({
    queryKey: ['staged', 'list', status],
    queryFn: () =>
      unwrap(
        api.v1['staged-changes'].get({
          query: {
            status,
            limit: 100,
          },
        }),
      ),
  })

export const environmentStagedQuery = (environment: string) =>
  queryOptions({
    queryKey: ['staged', 'in', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          ['staged-changes'].get({
            query: {
              limit: 100,
            },
          }),
      ),
  })

export const stagedChangeQuery = (id: string) =>
  queryOptions({
    queryKey: ['staged', id],
    queryFn: () =>
      unwrap(
        api.v1['staged-changes']({
          id,
        }).get({
          query: {
            fields:
              'id,environment_id,status,source,actor,created_at,summary,changes,refs,deployments,accepted_by',
          },
        }),
      ),
  })

const sandboxFields =
  'id,environment_id,station_id,name,status,status_reason,desired_state,image,size,network,docker,egress,ttl_s,stop_at,delete_at,address,disk_used_bytes,forked_from,created_at,failure,exit_code'

export const sandboxesQuery = (environment: string) =>
  queryOptions({
    queryKey: ['sandboxes', 'of', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          .sandboxes.get({
            query: {
              limit: 200,
              fields: sandboxFields,
            },
          }),
      ),
    refetchInterval: (query) =>
      query.state.data?.items.some((s) => isTransient(s.status)) ? 2000 : false,
  })

export const sandboxQuery = (sandbox: string) =>
  queryOptions({
    queryKey: ['sandboxes', sandbox],
    queryFn: () =>
      unwrap(
        api.v1
          .sandboxes({
            sandbox,
          })
          .get({
            query: {
              fields: `${sandboxFields},metrics`,
            },
          }),
      ),
    refetchInterval: (query) =>
      query.state.data && !isTransient(query.state.data.status)
        ? query.state.data.status === 'running'
          ? 5000
          : false
        : 2000,
  })

export const sandboxSnapshotsQuery = (environment: string) =>
  queryOptions({
    queryKey: ['sandbox-snapshots', 'of', environment],
    queryFn: () =>
      unwrap(
        api.v1
          .environments({
            environment,
          })
          ['sandbox-snapshots'].get({
            query: {
              limit: 200,
            },
          }),
      ),
    refetchInterval: (query) => (snapshotsBusy(query.state.data?.items) ? 2000 : false),
  })

export const sandboxOwnSnapshotsQuery = (sandbox: string) =>
  queryOptions({
    queryKey: ['sandbox-snapshots', 'from', sandbox],
    queryFn: () =>
      unwrap(
        api.v1
          .sandboxes({
            sandbox,
          })
          .snapshots.get({
            query: {
              limit: 200,
            },
          }),
      ),
    refetchInterval: (query) => (snapshotsBusy(query.state.data?.items) ? 2000 : false),
  })

export const sandboxVariablesQuery = (sandbox: string) =>
  queryOptions({
    queryKey: ['variables', 'of-sandbox', sandbox],
    queryFn: () =>
      unwrap(
        api.v1
          .sandboxes({
            sandbox,
          })
          .variables.get({
            query: {},
          }),
      ),
  })

export const sandboxResolvedQuery = (sandbox: string) =>
  queryOptions({
    queryKey: ['variables', 'resolved-sandbox', sandbox],
    queryFn: () =>
      unwrap(
        api.v1
          .sandboxes({
            sandbox,
          })
          .variables.resolved.get(),
      ),
    staleTime: 0,
    gcTime: 0,
  })
