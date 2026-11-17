import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import { ApiError, refusal } from './api/errors.ts'
import type { Surface } from './auth/principal.ts'

export const dashboardDir = fileURLToPath(new URL('../../dashboard/dist', import.meta.url))

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const compressible = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest'])

export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
}

const serverPrefixes = [
  '/v1/',
  '/mcp',
  '/auth/',
  '/.well-known/',
  '/openapi',
  '/schema/',
  '/docs',
  '/llms.txt',
  '/github/',
  '/device',
]

export const isServerPath = (path: string) =>
  path === '/v1' || serverPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))

type Asset = {
  type: string
  body: Buffer
  br: Buffer | null
  gzip: Buffer | null
  immutable: boolean
}

const walk = (dir: string): string[] =>
  readdirSync(dir, {
    withFileTypes: true,
  }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )

const load = (dir: string) => {
  const assets = new Map<string, Asset>()

  if (!existsSync(join(dir, 'index.html'))) {
    return assets
  }

  for (const file of walk(dir)) {
    const path = `/${relative(dir, file).split(sep).join('/')}`
    const ext = extname(file)
    const body = readFileSync(file)
    const squeeze = compressible.has(ext) && body.length > 1024

    assets.set(path, {
      type: contentTypes[ext] ?? 'application/octet-stream',
      body,
      br: squeeze
        ? brotliCompressSync(body, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 11,
            },
          })
        : null,
      gzip: squeeze
        ? gzipSync(body, {
            level: 9,
          })
        : null,
      immutable: path.startsWith('/assets/'),
    })
  }

  return assets
}

const accepts = (request: Request, coding: string) =>
  (request.headers.get('accept-encoding') ?? '')
    .split(',')
    .some((part) => part.trim().split(';')[0] === coding)

const respond = (request: Request, asset: Asset, version: string) => {
  const headers = new Headers({
    ...securityHeaders,
    'content-type': asset.type,
    'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-stationly-version': version,
    vary: 'accept-encoding',
  })
  let body = asset.body

  if (asset.br && accepts(request, 'br')) {
    body = asset.br
    headers.set('content-encoding', 'br')
  } else if (asset.gzip && accepts(request, 'gzip')) {
    body = asset.gzip
    headers.set('content-encoding', 'gzip')
  }

  headers.set('content-length', String(body.length))

  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers,
  })
}

export const createDashboard = (dir: string, version: string) => {
  const assets = load(dir)
  const index = assets.get('/index.html')

  return {
    built: Boolean(index),
    files: assets.size,
    handle: (request: Request, surface: Surface | null): Response | null => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return null
      }

      const path = new URL(request.url).pathname

      if (isServerPath(path) || surface === null) {
        return null
      }

      if (surface === 'api') {
        return refusal(
          request,
          new ApiError(
            'WRONG_HOST',
            `The API host does not serve the dashboard page ${path}.`,
            'Open the dashboard hostname instead.',
          ),
          version,
        )
      }

      if (!index) {
        return null
      }

      const asset = assets.get(path)

      if (asset && path !== '/index.html') {
        return respond(request, asset, version)
      }

      if (extname(path) && path !== '/index.html') {
        return refusal(request, new ApiError('NOT_FOUND', `No dashboard file ${path}.`), version)
      }

      return respond(request, index, version)
    },
  }
}

export type Dashboard = ReturnType<typeof createDashboard>
