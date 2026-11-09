export const manifestAccept =
  'application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, */*'

export type Reference = { registry: string; apiHost: string; repository: string; tag: string | null; digest: string | null }

const insecureRegistries = () =>
  new Set(
    (process.env.STATIONLY_INSECURE_REGISTRIES ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )

export const schemeFor = (host: string) => (insecureRegistries().has(host) ? 'http' : 'https')

export const parseReference = (input: string): Reference => {
  let rest = decodeURIComponent(input.replace(/^pkg:docker\//, '').replace(/\?.*$/, ''))
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  const slash = rest.indexOf('/')
  const first = slash >= 0 ? rest.slice(0, slash) : ''
  const hasRegistry = slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')
  let registry = hasRegistry ? first : 'docker.io'
  let path = hasRegistry ? rest.slice(slash + 1) : rest
  let tag: string | null = null
  const colon = path.lastIndexOf(':')
  if (colon >= 0) {
    tag = path.slice(colon + 1)
    path = path.slice(0, colon)
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io'
  if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`
  const apiHost = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  return { registry, apiHost, repository: path, tag, digest }
}

export const displayRef = (r: Reference) => `${r.registry}/${r.repository}${r.tag ? `:${r.tag}` : ''}`

type Challenge = { realm: string; service: string | null; scope: string | null }

const parseChallenge = (header: string | null): Challenge | null => {
  if (!header || !/^Bearer\s/i.test(header)) return null
  const params: Record<string, string> = {}
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]!.toLowerCase()] = m[2]!
  return params.realm ? { realm: params.realm, service: params.service ?? null, scope: params.scope ?? null } : null
}

const tokenCache = new Map<string, { token: string; expires: number }>()

export type Hop = { host: string; status: number; kind: 'registry' | 'token' | 'redirect' }

export type RegistryResponse = { status: number; headers: Headers; body: Buffer | null; hops: Hop[]; error: string | null }

export type RequestOptions = { method: 'HEAD' | 'GET'; accept: string; timeoutMs?: number; maxBytes?: number; errorBody?: boolean; fetchImpl?: typeof fetch }

const fetchToken = async (challenge: Challenge, fallbackScope: string, hops: Hop[], opts: RequestOptions) => {
  const scope = challenge.scope ?? fallbackScope
  const key = `${challenge.realm}|${challenge.service ?? ''}|${scope}`
  const cached = tokenCache.get(key)
  if (cached && cached.expires > Date.now()) return { token: cached.token }
  const url = new URL(challenge.realm)
  if (challenge.service) url.searchParams.set('service', challenge.service)
  url.searchParams.set('scope', scope)
  const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), redirect: 'manual' })
  hops.push({ host: url.host, status: res.status, kind: 'token' })
  if (res.status !== 200) return { status: res.status }
  const doc = (await res.json()) as { token?: string; access_token?: string; expires_in?: number }
  const token = doc.token ?? doc.access_token
  if (!token) return { status: 502 }
  tokenCache.set(key, { token, expires: Date.now() + Math.max(60, doc.expires_in ?? 60) * 1000 - 5000 })
  return { token }
}

export const registryRequest = async (ref: Reference, path: string, opts: RequestOptions): Promise<RegistryResponse> => {
  const hops: Hop[] = []
  const fetchImpl = opts.fetchImpl ?? fetch
  const origin = `${schemeFor(ref.apiHost)}://${ref.apiHost}`
  const scope = `repository:${ref.repository}:pull`
  let url = new URL(`${origin}/v2/${ref.repository}/${path}`)
  let token: string | null = null
  let triedToken = false
  try {
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { accept: opts.accept }
      if (token && url.host === ref.apiHost) headers.authorization = `Bearer ${token}`
      const res = await fetchImpl(url, { method: opts.method, headers, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
      hops.push({ host: url.host, status: res.status, kind: url.host === ref.apiHost ? 'registry' : 'redirect' })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url)
        continue
      }
      if (res.status === 401 && !triedToken && url.host === ref.apiHost) {
        triedToken = true
        const challenge = parseChallenge(res.headers.get('www-authenticate'))
        if (!challenge) return { status: 401, headers: res.headers, body: null, hops, error: 'no bearer challenge' }
        const got = await fetchToken(challenge, scope, hops, opts)
        if (!got.token) return { status: got.status === 401 || got.status === 403 ? 401 : (got.status ?? 401), headers: res.headers, body: null, hops, error: `token realm answered ${got.status}` }
        token = got.token
        continue
      }
      let body: Buffer | null = null
      if (opts.method === 'GET' && (res.status === 200 || opts.errorBody)) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (opts.maxBytes && buf.length > opts.maxBytes) return { status: 413, headers: res.headers, body: null, hops, error: `body above ${opts.maxBytes} bytes` }
        body = buf
      }
      return { status: res.status, headers: res.headers, body, hops, error: null }
    }
    return { status: 508, headers: new Headers(), body: null, hops, error: 'too many redirects' }
  } catch (error) {
    return { status: 0, headers: new Headers(), body: null, hops, error: (error as Error).message }
  }
}
