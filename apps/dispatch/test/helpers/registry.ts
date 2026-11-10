import { createHash } from 'node:crypto'
import { mock } from 'node:test'

type Entry = { body: string; mediaType: string; status: number }

export type RegistryRequest = { host: string; path: string; method: string }

const sha = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`

export class FakeRegistry {
  readonly requests: RegistryRequest[] = []
  private readonly tags = new Map<string, Entry>()
  private readonly digests = new Map<string, Entry>()
  private readonly failures = new Map<
    string,
    { status: number; body?: unknown; headers?: Record<string, string> }
  >()
  private counter = 0
  private restoreFetch: (() => void) | null = null

  static install() {
    const registry = new FakeRegistry()
    const stub = mock.method(
      globalThis,
      'fetch',
      (input: string | URL | Request, init?: RequestInit) =>
        registry.handle(new Request(input, init)),
    )
    registry.restoreFetch = () => stub.mock.restore()
    return registry
  }

  restore() {
    this.restoreFetch?.()
  }

  publish(reference: string, platforms: string[] = ['linux/arm64', 'linux/amd64']) {
    const [repository, tag] = split(reference)
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      nonce: ++this.counter,
      manifests: platforms.map((p, i) => {
        const [os, architecture] = p.split('/')
        return {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${String(i + 1).repeat(64)}`,
          size: 1,
          platform: {
            os,
            architecture,
          },
        }
      }),
    })
    const entry: Entry = {
      body,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      status: 200,
    }
    const digest = sha(body)
    this.tags.set(`${repository}:${tag}`, entry)
    this.digests.set(`${repository}@${digest}`, entry)
    return digest
  }

  fail(reference: string, status: number, body?: unknown, headers?: Record<string, string>) {
    const [repository, tag] = split(reference)
    this.failures.set(`${repository}:${tag}`, {
      status,
      body,
      headers,
    })
  }

  clearFailures() {
    this.failures.clear()
  }

  manifestRequests() {
    return this.requests.filter((r) => r.path.includes('/manifests/'))
  }

  private handle(request: Request) {
    const url = new URL(request.url)
    this.requests.push({
      host: url.host,
      path: url.pathname,
      method: request.method,
    })
    if (url.host !== 'registry-1.docker.io' && !url.host.endsWith('registry.test'))
      return Promise.reject(new Error(`the test registry does not serve ${url.host}`))
    const match = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname)
    if (!match)
      return Promise.resolve(
        new Response('{}', {
          status: 404,
        }),
      )
    const [, repository, reference] = match as unknown as [string, string, string]
    const failure = this.failures.get(`${repository}:${reference}`)
    if (failure)
      return Promise.resolve(
        new Response(
          JSON.stringify(
            failure.body ?? {
              errors: [],
            },
          ),
          {
            status: failure.status,
            headers: failure.headers,
          },
        ),
      )
    const entry = reference.startsWith('sha256:')
      ? this.digests.get(`${repository}@${reference}`)
      : this.tags.get(`${repository}:${reference}`)
    if (!entry)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            errors: [
              {
                code: reference.startsWith('sha256:') ? 'MANIFEST_UNKNOWN' : 'MANIFEST_UNKNOWN',
              },
            ],
          }),
          {
            status: 404,
          },
        ),
      )
    return Promise.resolve(
      new Response(entry.body, {
        status: 200,
        headers: {
          'content-type': entry.mediaType,
          'docker-content-digest': sha(entry.body),
        },
      }),
    )
  }
}

const split = (reference: string) => {
  const at = reference.indexOf('@')
  if (at >= 0) return [qualify(reference.slice(0, at)), reference.slice(at + 1)] as const
  const colon = reference.lastIndexOf(':')
  const slash = reference.lastIndexOf('/')
  return colon > slash
    ? ([qualify(reference.slice(0, colon)), reference.slice(colon + 1)] as const)
    : ([qualify(reference), 'latest'] as const)
}

const qualify = (repository: string) =>
  repository.includes('/') ? repository : `library/${repository}`
