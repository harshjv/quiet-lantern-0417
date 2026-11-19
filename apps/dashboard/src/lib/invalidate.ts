import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'

export const groups = {
  projects: [['projects']],
  previews: [['previews'], ['projects']],
  apps: [['apps'], ['previews'], ['projects']],
  deployments: [['deployments'], ['apps'], ['projects'], ['previews']],
  health: [['apps'], ['projects']],
  keys: [['keys'], ['apps']],
  domains: [['domains'], ['apps'], ['network']],
  networking: [
    ['ports'],
    ['domains'],
    ['apps'],
    ['deployments'],
    ['network'],
  ],
  machines: [['machines'], ['machine-snapshots'], ['tasks'], ['projects']],
  tasks: [['tasks'], ['approvals']],
  stations: [['stations']],
  approvals: [['approvals']],
  tokens: [['tokens']],
  auth: [['auth']],
} satisfies Record<string, QueryKey[]>

export type Group = keyof typeof groups

export const approvalDecided: Group[] = ['approvals', 'apps', 'keys', 'networking', 'deployments']

export const invalidateGroups = (client: QueryClient, names: Group[]) => {
  const keys = new Map<string, QueryKey>(
    names.flatMap((name) => groups[name]).map((key) => [JSON.stringify(key), key]),
  )

  for (const queryKey of keys.values()) {
    void client.invalidateQueries({
      queryKey,
    })
  }
}

export const useInvalidate = () => {
  const client = useQueryClient()

  return (...names: Group[]) => invalidateGroups(client, names)
}
