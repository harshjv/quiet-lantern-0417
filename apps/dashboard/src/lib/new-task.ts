const repositoryShape = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export const repositoryUrl = (text: string) => {
  const value = text.trim()

  if (repositoryShape.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, '')}`
  }

  return /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~-]+)+$/.test(value)
    ? value.replace(/\.git$/, '')
    : null
}

export const credentialKey = (keys: readonly string[], value: string) =>
  (value.trim().startsWith('sk-ant-api')
    ? keys.find((key) => key === 'ANTHROPIC_API_KEY')
    : keys.find((key) => key.endsWith('OAUTH_TOKEN'))) ?? keys[0]!

export const githubTokenKey = 'GH_TOKEN'

export const githubTokenLabel = 'GitHub token'

export const githubTokenHelp = (project: string, repository: string) =>
  `${project} has no GitHub token, and ${repository} is private or does not exist. Paste a fine-grained token with Contents read and write on that repository, or the output of gh auth token. Stationly stores it sealed for the whole project.`

type Failing = { code: string; details: Record<string, unknown> }

export const needsGithubToken = (failure: unknown) =>
  (failure as Failing | null)?.code === 'REPO_ACCESS_REQUIRED'

export const githubTokenRefused = (failure: unknown) =>
  (failure as Failing | null)?.code === 'REPO_ACCESS_DENIED'
