import type { Static } from '@sinclair/typebox'

import type { SandboxVariableSet } from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { githubWeb } from '../github/client.ts'
import { http, transientRetry, userAgent } from '../net/http.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { decryptValue, headValue, variablesOf } from '../secrets/values.ts'

export type RepositoryAccess = 'readable' | 'unreadable' | 'unknown'

export type ReadRepository = (repository: string, token: string | null) => Promise<RepositoryAccess>

const tokenKey = 'GH_TOKEN'

const probeTimeoutMs = 10_000

const refused = new Set([401, 403, 404])

export const readRepository: ReadRepository = async (repository, token) => {
  try {
    const response = await http(
      `${repository.replace(/\.git$/, '')}.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          'user-agent': `git/2.34.1 (${userAgent})`,
          authorization: token
            ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
            : undefined,
        },
        timeout: probeTimeoutMs,
        retry: transientRetry,
        throwHttpErrors: false,
      },
    )

    return response.status === 200
      ? 'readable'
      : refused.has(response.status)
        ? 'unreadable'
        : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const isGitHubRepository = (repository: string) =>
  new URL(repository).host === new URL(githubWeb()).host

export const repositoryLabel = (repository: string) =>
  new URL(repository).pathname
    .split('/')
    .filter(Boolean)
    .slice(0, 2)
    .join('/')
    .replace(/\.git$/, '')

const projectToken = (
  db: Db,
  keyring: Keyring,
  scope: { project: string; environment: string },
) => {
  const found = variablesOf(db, {
    scope: 'project',
    id: scope.project,
  })
    .all()
    .find((variable) => variable.key === tokenKey)
  const head = found
    ? (headValue(db, found.id, scope.environment) ?? headValue(db, found.id, null))
    : undefined

  return head ? decryptValue(keyring, head) : null
}

export const requireRepositoryAccess = async (
  deps: { db: Db; keyring: Keyring; readRepository: ReadRepository },
  request: {
    project: { id: string; name: string }
    environment: string
    repository: string
    variables: Static<typeof SandboxVariableSet>[] | undefined
  },
) => {
  if (!isGitHubRepository(request.repository)) {
    return
  }

  if ((await deps.readRepository(request.repository, null)) !== 'unreadable') {
    return
  }

  const supplied = request.variables?.find(
    (variable) => variable.key === tokenKey && variable.kind !== 'reference',
  )?.value
  const stored = projectToken(deps.db, deps.keyring, {
    project: request.project.id,
    environment: request.environment,
  })
  const token = supplied ?? stored
  const name = repositoryLabel(request.repository)
  const details = {
    repository: name,
    project: request.project.name,
  }

  if (!token) {
    fail(
      'REPO_ACCESS_REQUIRED',
      `${name} cannot be read without credentials, and project ${request.project.name} has no ${tokenKey}.`,
      `Set ${tokenKey} on project ${request.project.name} with set_project_variables: a fine-grained token with Contents read and write on ${name}, or the output of gh auth token.`,
      details,
    )
  }

  if ((await deps.readRepository(request.repository, token)) === 'unreadable') {
    fail(
      'REPO_ACCESS_DENIED',
      `The project's GitHub token cannot read ${name}.`,
      `Set ${tokenKey} on project ${request.project.name} to a token that can read ${name}, or check the repository name.`,
      details,
    )
  }
}
