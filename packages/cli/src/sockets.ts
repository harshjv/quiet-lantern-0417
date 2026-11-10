import { createServer, type Socket } from 'node:net'
import { credentialHeaders, type Run } from './kit.ts'

export const attachUrl = (run: Run, path: string) => {
  const url = new URL(path, run.credentials.instance)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

export const openSocket = (run: Run, url: URL) => {
  const ws = new WebSocket(url, { headers: { ...credentialHeaders(run.credentials, 'GET', url.href), 'user-agent': run.userAgent } } as unknown as string[])
  ws.binaryType = 'arraybuffer'
  return ws
}

export const bytesOfMessage = (data: unknown) => Buffer.from(data as ArrayBuffer)

export type ForwardEvents = { control?: (message: string) => void; unopened?: () => void }

export const forwardPort = async (run: Run, sandboxId: string, remote: number, localPort: number | undefined, events: ForwardEvents = {}) => {
  const connections = new Set<Socket>()
  const server = createServer(socket => {
    connections.add(socket)
    const url = attachUrl(run, `/v1/sandboxes/${sandboxId}/forward`)
    url.searchParams.set('port', String(remote))
    const ws = openSocket(run, url)
    const queued: Buffer[] = []
    let open = false
    ws.onopen = () => {
      open = true
      for (const chunk of queued) ws.send(Buffer.concat([Buffer.from([0]), chunk]))
      queued.length = 0
    }
    ws.onmessage = message => {
      if (typeof message.data === 'string') {
        const control = JSON.parse(message.data) as { type: string; reason?: string; explanation?: string }
        if (control.type === 'error') events.control?.(`forward failed: ${control.explanation}`)
        if (control.type === 'end' && control.reason) events.control?.(`forward ended: ${control.reason}`)
        return
      }
      socket.write(bytesOfMessage(message.data).subarray(1))
    }
    ws.onclose = () => socket.end()
    ws.onerror = () => {
      socket.destroy()
      if (!open) events.unopened?.()
    }
    socket.on('data', (chunk: Buffer) => (open ? ws.send(Buffer.concat([Buffer.from([0]), chunk])) : queued.push(chunk)))
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
  const bound = await listen(localPort ?? remote).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && localPort === undefined) return listen(0)
    throw error
  })
  const close = () =>
    new Promise<void>(resolve => {
      for (const socket of connections) socket.destroy()
      server.close(() => resolve())
    })
  return { server, address: `127.0.0.1:${bound}`, close }
}
