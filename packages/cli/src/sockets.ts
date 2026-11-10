import { createServer, type Socket } from 'node:net'

import { exitCodes } from './errors.ts'
import { credentialHeaders, type Run } from './kit.ts'
import { progress } from './output.ts'

const attachUrl = (run: Run, path: string) => {
  const url = new URL(path, run.credentials.instance)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

const openSocket = (run: Run, url: URL) => {
  const ws = new WebSocket(url, {
    headers: {
      ...credentialHeaders(run.credentials, 'GET', url.href),
      'user-agent': run.userAgent,
    },
  })
  ws.binaryType = 'arraybuffer'
  return ws
}

const bytesOfMessage = (data: unknown) => Buffer.from(data as ArrayBuffer)

const framed = (chunk: Buffer) => Buffer.concat([Buffer.from([0]), chunk])

type RunExit = { status: string; exit_code: number | null }

type AttachMode = { tty: boolean; stdin: boolean; json: boolean }

export const attachRun = (run: Run, created: { attach_url: string }, mode: AttachMode) => {
  const url = attachUrl(run, created.attach_url)
  url.searchParams.set('rows', String(process.stdout.rows ?? 24))
  url.searchParams.set('cols', String(process.stdout.columns ?? 80))
  const ws = openSocket(run, url)
  const out = mode.json ? process.stderr : process.stdout
  return new Promise<RunExit | null>((resolve) => {
    let exit: RunExit | null = null
    const restore = () => {
      if (mode.tty && process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    ws.onopen = () => {
      if (mode.tty) process.stdin.setRawMode(true)
      if (!mode.stdin) return
      process.stdin.on(
        'data',
        (chunk: Buffer) => ws.readyState === ws.OPEN && ws.send(framed(chunk)),
      )
      process.stdin.on(
        'end',
        () =>
          ws.readyState === ws.OPEN &&
          ws.send(
            JSON.stringify({
              type: 'eof',
            }),
          ),
      )
      if (mode.tty)
        process.stdout.on(
          'resize',
          () =>
            ws.readyState === ws.OPEN &&
            ws.send(
              JSON.stringify({
                type: 'resize',
                rows: process.stdout.rows,
                cols: process.stdout.columns,
              }),
            ),
        )
      process.stdin.resume()
    }
    ws.onmessage = (message) => {
      if (typeof message.data === 'string') {
        const control = JSON.parse(message.data) as {
          type: string
          status?: string
          exit_code?: number | null
          code?: string
          explanation?: string
          run_id?: string
        }
        if (control.type === 'attached') progress(`attached to ${control.run_id}`)
        if (control.type === 'exit')
          exit = {
            status: control.status!,
            exit_code: control.exit_code ?? null,
          }
        if (control.type === 'error')
          process.stderr.write(`error: ${control.explanation}\n${control.code}\n`)
        return
      }
      const bytes = bytesOfMessage(message.data)
      ;(bytes[0] === 2 ? process.stderr : out).write(bytes.subarray(1))
    }
    ws.onclose = () => {
      restore()
      resolve(exit)
    }
    ws.onerror = () => progress('the attach connection failed')
  })
}

export const shellExit = (id: string, exit: RunExit | null) => {
  if (!exit) return exitCodes.connection
  progress(`${id}: ${exit.status}, exit code ${exit.exit_code ?? '-'}`)
  return exit.status === 'succeeded' ? exitCodes.ok : exitCodes.api
}

export type ForwardEvents = { control?: (message: string) => void; unopened?: () => void }

export const forwardPort = async (
  run: Run,
  sandboxId: string,
  remote: number,
  localPort: number | undefined,
  events: ForwardEvents = {},
) => {
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    const url = attachUrl(run, `/v1/sandboxes/${sandboxId}/forward`)
    url.searchParams.set('port', String(remote))
    const ws = openSocket(run, url)
    const queued: Buffer[] = []
    let open = false
    ws.onopen = () => {
      open = true
      for (const chunk of queued) ws.send(framed(chunk))
      queued.length = 0
    }
    ws.onmessage = (message) => {
      if (typeof message.data === 'string') {
        const control = JSON.parse(message.data) as {
          type: string
          reason?: string
          explanation?: string
        }
        if (control.type === 'error') events.control?.(`forward failed: ${control.explanation}`)
        if (control.type === 'end' && control.reason)
          events.control?.(`forward ended: ${control.reason}`)
        return
      }
      socket.write(bytesOfMessage(message.data).subarray(1))
    }
    ws.onclose = () => socket.end()
    ws.onerror = () => {
      socket.destroy()
      if (!open) events.unopened?.()
    }
    socket.on('data', (chunk: Buffer) => (open ? ws.send(framed(chunk)) : queued.push(chunk)))
    socket.on('close', () => {
      connections.delete(socket)
      ws.close()
    })
    socket.on('error', () => socket.destroy())
  })
  const listen = (at: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(at, '127.0.0.1', () => {
        server.off('error', reject)
        resolve((server.address() as { port: number }).port)
      })
    })
  const bound = await listen(localPort ?? remote).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && localPort === undefined)
      return listen(0)
    throw error
  })
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of connections) socket.destroy()
      server.close(() => resolve())
    })
  return {
    server,
    address: `127.0.0.1:${bound}`,
    close,
  }
}
