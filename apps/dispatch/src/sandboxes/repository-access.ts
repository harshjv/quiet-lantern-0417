import type { Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import type { MachineKeySet } from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { target } from '../db/schema.ts'
import { githubWeb } from '../github/client.ts'
import { http, transientRetry, userAgent } from '../net/http.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { decryptValue, headValue, keysOf } from '../secrets/values.ts'

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

export const projectHead = (db: Db, scope: { project: string; target: string }, name: string) => {
  const found = keysOf(db, {
    scope: 'project',
    id: scope.project,
  })
    .all()
    .find((row) => row.name === name)
  const place = db.select().from(target).where(eq(target.id, scope.target)).get()
  const inPreview = place?.kind === 'preview'
  const preview = found && inPreview ? headValue(db, found.id, 'preview') : undefined

  return found
    ? (preview ??
        (inPreview && found.kind === 'sealed' ? undefined : headValue(db, found.id, 'production')))
    : undefined
}

export const projectSecret = (
  db: Db,
  keyring: Keyring,
  scope: { project: string; target: string },
  name: string,
) => {
  const head = projectHead(db, scope, name)

  return head ? decryptValue(keyring, head) : null
}

export const requireRepositoryAccess = async (
  deps: { db: Db; keyring: Keyring; readRepository: ReadRepository },
  request: {
    project: { id: string; name: string }
    target: string
    repository: string
    keys: Static<typeof MachineKeySet>[] | undefined
  },
) => {
  if (!isGitHubRepository(request.repository)) {
    return
  }

  if ((await deps.readRepository(request.repository, null)) !== 'unreadable') {
    return
  }

  const supplied = request.keys?.find(
    (set) => set.name === tokenKey && set.kind !== 'reference',
  )?.value
  const stored = projectSecret(
    deps.db,
    deps.keyring,
    {
      project: request.project.id,
      target: request.target,
    },
    tokenKey,
  )
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
      `Set ${tokenKey} on project ${request.project.name} with set_project_keys: a fine-grained token with Contents read and write on ${name}, or the output of gh auth token.`,
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
