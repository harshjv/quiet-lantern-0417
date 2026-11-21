export const attachUrl = (path: string, origin: string, size: { rows: number; cols: number }) => {
  const url = new URL(path, origin)

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('rows', String(size.rows))
  url.searchParams.set('cols', String(size.cols))

  return url.toString()
}

export const stdinFrame = (data: string) => {
  const bytes = new TextEncoder().encode(data)
  const frame = new Uint8Array(bytes.length + 1)

  frame.set(bytes, 1)

  return frame
}

export const outputFrame = (frame: ArrayBuffer) => {
  const view = new Uint8Array(frame)

  return {
    channel: view[0] ?? 0,
    bytes: view.subarray(1),
  }
}
