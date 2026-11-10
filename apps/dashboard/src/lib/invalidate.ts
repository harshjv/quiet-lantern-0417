import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'

export const groups = {
  projects: [['projects']],
  environments: [['environments'], ['projects']],
  services: [['services'], ['environments'], ['projects']],
  deployments: [['deployments'], ['services'], ['projects'], ['environments']],
  health: [['services'], ['projects']],
  variables: [['variables'], ['services']],
  domains: [['domains'], ['services'], ['network']],
  networking: [['ports'], ['domains'], ['port-allocations'], ['services'], ['deployments'], ['network']],
  sandboxes: [['sandboxes'], ['sandbox-snapshots']],
  staged: [['staged']],
  auth: [['auth']]
} satisfies Record<string, QueryKey[]>

export type Group = keyof typeof groups

export const stagedDecided: Group[] = ['staged', 'services', 'variables', 'networking', 'deployments']

export const invalidateGroups = (client: QueryClient, names: Group[]) => {
  const keys = new Map<string, QueryKey>(names.flatMap(name => groups[name]).map(key => [JSON.stringify(key), key]))
  for (const queryKey of keys.values()) void client.invalidateQueries({ queryKey })
}

export const useInvalidate = () => {
  const client = useQueryClient()
  return (...names: Group[]) => invalidateGroups(client, names)
}
