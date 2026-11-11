import { createHmac, sign, timingSafeEqual } from 'node:crypto'

import { isHTTPError } from 'ky'

import { env } from '../env.ts'
import { http, transientRetry, userAgent } from '../net/http.ts'

export const apiVersion = '2026-03-10'

export const githubWeb = () => env().STATIONLY_GITHUB_URL

export const splitRepo = (repo: string) => {
  const [, owner, name] = repo.split('/') as [string, string, string]

  return {
    owner,
    name,
    full_name: `${owner}/${name}`,
  }
}

export const repoOf = (fullName: string) => `github.com/${fullName.toLowerCase()}`

export const cloneUrl = (repo: string) => `${githubWeb()}/${splitRepo(repo).full_name}.git`

export class GitHubError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export const appJwt = (clientId: string, pem: string, now = Math.floor(Date.now() / 1000)) => {
  const header = b64url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
    }),
  )
  const payload = b64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: clientId,
    }),
  )
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), pem).toString('base64url')

  return `${header}.${payload}.${signature}`
}

export type GitHubResponse<T> = { status: number; headers: Headers; data: T }

const api = http.extend({
  headers: {
    accept: 'application/vnd.github+json',
    'x-github-api-version': apiVersion,
  },
  retry: transientRetry,
  throwHttpErrors: (status) => status >= 400,
  hooks: {
    beforeError: [
      ({ error }) => {
        if (!isHTTPError(error)) {
          return error
        }

        const { pathname, search } = new URL(error.request.url)
        const { status } = error.response
        const message =
          (error.data as { message?: string } | undefined)?.message ?? `HTTP ${status}`

        return new GitHubError(
          status,
          `GitHub ${error.request.method} ${pathname}${search} answered ${status}: ${message}`,
          error.data ?? null,
        )
      },
    ],
  },
})

export const gh = async <T = unknown>(
  path: string,
  options: {
    method?: string
    token?: string
    body?: unknown
    etag?: string | null
  } = {},
): Promise<GitHubResponse<T>> => {
  const response = await api(`${env().STATIONLY_GITHUB_API_URL}${path}`, {
    method: options.method,
    headers: {
      authorization: options.token ? `Bearer ${options.token}` : undefined,
      'if-none-match': options.etag ?? undefined,
    },
    json: options.body,
  })
  const text = await response.text()

  return {
    status: response.status,
    headers: response.headers,
    data: (text ? JSON.parse(text) : null) as T,
  }
}

export const signatureOf = (secret: string, body: Buffer) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

export const signatureValid = (secret: string, body: Buffer, header: string | null) => {
  if (!header) {
    return false
  }

  const want = Buffer.from(signatureOf(secret, body))
  const got = Buffer.from(header)

  return want.length === got.length && timingSafeEqual(want, got)
}

const pktLines = (body: Buffer) => {
  const lines: string[] = []
  let offset = 0

  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16)

    if (Number.isNaN(length)) {
      break
    }

    if (length === 0) {
      offset += 4
      continue
    }

    lines.push(
      body
        .subarray(offset + 4, offset + length)
        .toString('utf8')
        .replace(/\n$/, ''),
    )
    offset += length
  }

  return lines
}

export type Advertisement = { refs: Map<string, string>; head: string | null }

export const parseAdvertisement = (body: Buffer): Advertisement => {
  const refs = new Map<string, string>()
  let head: string | null = null

  for (const line of pktLines(body)) {
    if (line.startsWith('#')) {
      continue
    }

    const [refPart, capabilities] = line.split('\0') as [string, string | undefined]
    const [sha, name] = refPart.split(' ') as [string, string]

    if (/^[0-9a-f]{40}$/.test(sha) && name) {
      refs.set(name, sha)
    }

    const symref = capabilities?.split(' ').find((c) => c.startsWith('symref=HEAD:'))

    if (symref) {
      head = symref.slice('symref=HEAD:'.length)
    }
  }

  return {
    refs,
    head,
  }
}

export const advertisement = async (
  repo: string,
  token: string | null,
  etag: string | null = null,
) => {
  const response = await http(`${cloneUrl(repo)}/info/refs?service=git-upload-pack`, {
    headers: {
      'user-agent': `git/2.34.1 (${userAgent})`,
      authorization: token
        ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
        : undefined,
      'if-none-match': etag ?? undefined,
    },
    retry: transientRetry,
    throwHttpErrors: false,
  })

  if (response.status === 304) {
    return {
      status: 304 as const,
      etag,
      advertisement: null,
    }
  }

  const body = Buffer.from(await response.arrayBuffer())

  if (response.status !== 200 || !/^[0-9a-f]{4}#/.test(body.subarray(0, 5).toString('ascii'))) {
    throw new GitHubError(
      response.status,
      `${cloneUrl(repo)}/info/refs answered ${response.status}`,
      null,
    )
  }

  return {
    status: 200 as const,
    etag: response.headers.get('etag'),
    advertisement: parseAdvertisement(body),
  }
}
