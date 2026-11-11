const heartbeatMs = 15_000
const highWaterMark = 256 * 1024

export type Sse = {
  response: Response
  send: (event: string, data: unknown, id?: string | null) => Promise<void>
  close: () => void
  closed: () => boolean
  onClose: (f: () => void) => void
}

export const createSse = (signal: AbortSignal, headers: Record<string, string> = {}): Sse => {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let done = false
  const waiters: (() => void)[] = []
  const closers: (() => void)[] = []
  const finish = () => {
    if (done) {
      return
    }

    done = true
    clearInterval(heartbeat)

    for (const w of waiters.splice(0)) {
      w()
    }

    for (const c of closers.splice(0)) {
      c()
    }
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c
      },
      pull: () => {
        for (const w of waiters.splice(0)) {
          w()
        }
      },
      cancel: () => finish(),
    },
    {
      highWaterMark,
      size: (chunk) => chunk.byteLength,
    },
  )
  const write = (text: string) => {
    if (done) {
      return
    }

    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      finish()
    }
  }
  const heartbeat = setInterval(
    () => write(`: keepalive ${new Date().toISOString()}\n\n`),
    heartbeatMs,
  )

  signal.addEventListener('abort', finish, {
    once: true,
  })
  write(': connected\n\n')

  return {
    response: new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        ...headers,
      },
    }),
    send: async (event, data, id) => {
      write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

      while (!done && (controller.desiredSize ?? 1) <= 0) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
    close: () => {
      if (done) {
        return
      }

      try {
        controller.close()
      } catch {}

      finish()
    },
    closed: () => done,
    onClose: (f) => {
      if (done) {
        f()
      } else {
        closers.push(f)
      }
    },
  }
}
