import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAttachServer } from '../../src/api/attach.ts'
import { createApp, createFetch } from '../../src/app.ts'
import { AuthService } from '../../src/auth/auth.ts'
import { ensureInstanceId, setupInstance } from '../../src/auth/bootstrap.ts'
import { createMetadataFetch } from '../../src/auth/metadata-fetch.ts'
import { openDb, type Db } from '../../src/db/client.ts'
import { createGitHub } from '../../src/github/service.ts'
import { Keyring } from '../../src/secrets/keyring.ts'
import { createStationServer } from '../../src/station/server.ts'

import { FakeStation, type FakeStationConfig } from './fake-station.ts'

export const localOrigin = 'http://127.0.0.1:7900'
export const adminEmail = 'admin@example.com'
export const adminPassword = 'correct-horse-battery'

export type Reply<T = any> = { status: number; body: T; headers: Headers; text: string }

export type CallOptions = {
  token?: string | null
  cookie?: string
  body?: unknown
  headers?: Record<string, string>
  origin?: string | null
}

export type Dispatch = Awaited<ReturnType<typeof startDispatch>>

export const startDispatch = async (options: { version?: string; setup?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sly-dispatch-'))
  const databasePath = join(dir, 'dispatch.sqlite')
  const blobDir = join(dir, 'blobs')

  mkdirSync(blobDir, {
    recursive: true,
  })
  const masterKey = randomBytes(32)
  const db = openDb(databasePath)

  ensureInstanceId(db)
  const keyring = new Keyring(db, masterKey)
  const version = options.version ?? '0.0.0'
  const auth = new AuthService(db, masterKey, localOrigin, createMetadataFetch(null))
  const github = createGitHub({
    db,
    keyring,
    auth,
  })
  const stations = createStationServer({
    db,
    keyring,
    blobDir,
    version,
    github,
    log: () => {},
  })
  const deps = {
    db,
    keyring,
    auth,
    version,
    stations,
    blobDir,
    github,
  }
  const app = createApp(deps)
  const fetchHandler = createFetch(deps, app)

  let listener: Server | null = null
  const stationUrl = async () => {
    if (listener) {
      return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
    }

    const server = createServer((req, res) => {
      if (!stations.handleRequest(req, res)) {
        res.writeHead(404).end()
      }
    })

    server.on('upgrade', (req, socket, head) => stations.handleUpgrade(req, socket, head))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    listener = server

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const fakeStations: FakeStation[] = []

  const call = async <T = any>(
    method: string,
    path: string,
    opts: CallOptions = {},
  ): Promise<Reply<T>> => {
    const headers = new Headers({
      'x-forwarded-for': '198.51.100.1',
      ...opts.headers,
    })

    if (opts.token) {
      headers.set('authorization', `Bearer ${opts.token}`)
    }

    if (opts.cookie) {
      headers.set('cookie', opts.cookie)
    }

    if (opts.origin !== null && opts.origin !== undefined) {
      headers.set('origin', opts.origin)
    }

    let payload: string | undefined

    if (opts.body !== undefined) {
      headers.set('content-type', 'application/json')
      payload = JSON.stringify(opts.body)
    }

    const response = await fetchHandler(
      new Request(`${localOrigin}${path}`, {
        method,
        headers,
        body: payload,
      }),
    )
    const text = await response.text()
    let body: unknown = text

    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    return {
      status: response.status,
      body: body as T,
      headers: response.headers,
      text,
    }
  }

  const close = async () => {
    await Promise.all(fakeStations.map((s) => s.close()))
    await stations.close()

    if (listener) {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener!.close(() => resolve()))
    }

    rmSync(dir, {
      recursive: true,
      force: true,
    })
  }

  const harness = {
    dir,
    databasePath,
    db: db as Db,
    deps,
    app,
    fetch: fetchHandler,
    call,
    stationUrl,
    close,
    fakeStations,
    admin: {
      email: adminEmail,
      password: adminPassword,
      userId: '',
      cookie: '',
      token: '',
    },
  }

  if (options.setup !== false) {
    await seedAdmin(harness)
  }

  return harness
}

type Booting = Pick<Dispatch, 'deps' | 'call' | 'admin'>

export const signIn = async (
  h: Pick<Dispatch, 'call'>,
  email = adminEmail,
  password = adminPassword,
) => {
  const reply = await h.call('POST', '/auth/sign-in/email', {
    origin: localOrigin,
    body: {
      email,
      password,
    },
  })
  const cookies = reply.headers.getSetCookie().map((c) => c.split(';')[0]!)

  return {
    reply,
    cookie: cookies.join('; '),
  }
}

const seedAdmin = async (h: Booting) => {
  const created = await setupInstance(
    {
      db: h.deps.db,
      keyring: h.deps.keyring,
      auth: h.deps.auth,
    },
    {
      email: adminEmail,
      password: adminPassword,
    },
    {
      type: 'system',
      id: null,
      client: 'test-harness',
    },
  )
  const { cookie } = await signIn(h)
  const minted = await h.call('POST', '/v1/tokens', {
    cookie,
    origin: localOrigin,
    body: {
      name: 'test personal',
      kind: 'personal',
    },
  })

  if (minted.status !== 201) {
    throw new Error(`could not mint the personal token: ${minted.text}`)
  }

  Object.assign(h.admin, {
    userId: created.admin_user_id,
    cookie,
    token: minted.body.key as string,
  })
}

export const mintToken = async (
  h: Dispatch,
  scopes: { project_id: string; environment_id: string; level: 'read' | 'deploy' | 'admin' }[],
  name = 'scoped',
) => {
  const reply = await h.call('POST', '/v1/tokens', {
    token: h.admin.token,
    body: {
      name,
      kind: 'scoped',
      scopes,
    },
  })

  if (reply.status !== 201) {
    throw new Error(`could not mint a scoped token: ${reply.text}`)
  }

  return reply.body.key as string
}

export const startFakeStation = async (
  h: Dispatch,
  name = 'station-1',
  config: FakeStationConfig = {},
) => {
  const url = await h.stationUrl()
  const added = await h.call('POST', '/v1/stations', {
    token: h.admin.token,
    body: {
      name,
    },
  })

  if (added.status !== 201 && added.status !== 200) {
    throw new Error(`could not add a station: ${added.text}`)
  }

  const station = await FakeStation.enrollAndStart(url, added.body.enroll_token as string, config)

  h.fakeStations.push(station)
  const deadline = Date.now() + 10_000

  while (
    (
      await h.call('GET', `/v1/stations/${name}`, {
        token: h.admin.token,
      })
    ).body?.status !== 'online'
  ) {
    if (Date.now() > deadline) {
      throw new Error(`station ${name} did not come online within 10 s`)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return station
}

export type RecordedRequest = { method: string; path: string; headers: Headers; body: string }

export const serveOverHttp = async (
  h: Pick<Dispatch, 'fetch'> & Partial<Pick<Dispatch, 'deps'>>,
  options: { attach?: boolean } = {},
) => {
  const { toNodeHandler } = await import('srvx/node')
  const requests: RecordedRequest[] = []
  const handler = toNodeHandler(async (request: Request) => {
    const url = new URL(request.url)

    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: new Headers(request.headers),
      body: await request.clone().text(),
    })

    return h.fetch(request)
  })
  const server = createServer(handler as Parameters<typeof createServer>[1])
  const attach = options.attach && h.deps ? createAttachServer(h.deps) : null

  if (attach) {
    server.on('upgrade', (req, socket, head) =>
      attach.matches(req) ? attach.handleUpgrade(req, socket, head) : socket.destroy(),
    )
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      attach?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
