import config from '../../../release.config.json' with { type: 'json' }

type RepositoryName = keyof typeof config.repositories

export const releaseConfig = config

export const releaseRepositories = Object.fromEntries(
  Object.entries(config.repositories).map(([name, path]) => [
    name,
    `${config.registry_namespace}/${path}`,
  ]),
) as Record<RepositoryName, string>
