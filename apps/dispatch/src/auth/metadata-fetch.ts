import { Resolver } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { Readable, Transform } from 'node:stream'

import { isPublicRoutableHost } from '@better-auth/core/utils/host'
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'

import { logError } from '../log.ts'

export const metadataFetchTimeoutMs = 5000
export const metadataFetchMaxBytes = 64 * 1024

export class MetadataFetchRefused extends TypeError {}

const refusal = (url: URL, reason: string) => {
  logError('cimd_fetch_refused', {
    url: url.href,
    reason,
  })

  return new MetadataFetchRefused(`client metadata fetch refused: ${reason}`)
}

const refuse = (url: URL, reason: string): never => {
  throw refusal(url, reason)
}

const responseHeaders = (raw: NodeJS.Dict<string | string[]>) => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item)
      }
    } else if (value !== undefined) {
      headers.append(name, value)
    }
  }

  return headers
}

const capped = (url: URL, limit: number) => {
  let seen = 0

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length

      if (seen > limit) {
        return done(refusal(url, `body exceeds ${limit} bytes`))
      }

      done(null, chunk)
    },
  })
}

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))

const withDeadline = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      return reject(abortReason(signal))
    }

    signal.addEventListener('abort', () => reject(abortReason(signal)), {
      once: true,
    })
    work.then(resolve, reject)
  })

export const createMetadataFetch =
  (resolverAddress: string | null): ClientMetadataResourceFetch =>
  async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init)
    const url = new URL(incoming.url)

    if (url.protocol !== 'https:') {
      return refuse(url, `scheme ${url.protocol} is not https`)
    }

    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      return refuse(url, `method ${incoming.method}`)
    }

    const deadline = AbortSignal.any([
      AbortSignal.timeout(metadataFetchTimeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ])
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: string[]

    if (isIP(host)) {
      addresses = [host]
    } else {
      if (!resolverAddress) {
        return refuse(url, 'no resolver is configured (STATIONLY_RESOLVER)')
      }

      const resolver = new Resolver({
        timeout: 2000,
        tries: 2,
      })

      resolver.setServers([resolverAddress])

      try {
        addresses = await withDeadline(resolver.resolve4(host), deadline)
      } catch (error) {
        return refuse(
          url,
          `resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const blocked = addresses.find((address) => !isPublicRoutableHost(address))

    if (!addresses.length || blocked) {
      return refuse(url, `address ${blocked ?? 'none'} is not public`)
    }

    const pinned = addresses[0]!
    const family = isIP(pinned)
    const headers = Object.fromEntries(incoming.headers.entries())

    headers.host = url.host

    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          agent: false,
          method: incoming.method,
          headers,
          signal: deadline,
          servername: isIP(host) ? undefined : host,
          lookup: (_hostname, options, callback) => {
            if ((options as { all?: boolean }).all) {
              ;(callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
                null,
                [
                  {
                    address: pinned,
                    family,
                  },
                ],
              )
            } else {
              callback(null, pinned, family)
            }
          },
        },
        (response) => {
          const status = response.statusCode ?? 502
          const declared = Number(response.headers['content-length'] ?? NaN)

          if (Number.isFinite(declared) && declared > metadataFetchMaxBytes) {
            response.destroy()

            return reject(
              refusal(url, `body declares ${declared} bytes, over ${metadataFetchMaxBytes}`),
            )
          }

          const empty =
            incoming.method === 'HEAD' ||
            status === 204 ||
            status === 304 ||
            (status >= 300 && status < 400)

          if (empty) {
            response.resume()
          }

          const body = empty
            ? null
            : (Readable.toWeb(
                response.pipe(capped(url, metadataFetchMaxBytes)),
              ) as ReadableStream<Uint8Array>)

          if (status >= 300 && status < 400) {
            refusal(
              url,
              `HTTP ${status} redirect to ${response.headers.location ?? 'nowhere'} is not followed`,
            )
          }

          resolve(
            new Response(body, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders(response.headers),
            }),
          )
        },
      )

      outgoing.once('error', (error) =>
        reject(
          deadline.aborted
            ? refusal(url, `timed out after ${metadataFetchTimeoutMs} ms`)
            : refusal(url, `connection failed: ${error.message}`),
        ),
      )
      outgoing.end()
    })
  }
