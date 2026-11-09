export const ttlLimits = { min: 60, max: 2_592_000, default: 3600 } as const

const unitSeconds = { s: 1, m: 60, h: 3600, d: 86_400 } as const

const segment = /^(\d+)([smhd]?)/

export const parseDuration = (text: string): number | null => {
  let rest = text.trim().toLowerCase().replaceAll(' ', '')
  if (!rest) return null
  let total = 0
  while (rest) {
    const match = segment.exec(rest)
    if (!match) return null
    total += Number(match[1]) * unitSeconds[(match[2] || 's') as keyof typeof unitSeconds]
    rest = rest.slice(match[0].length)
  }
  return total
}

export const ttlProblem = (seconds: number | null) => {
  if (seconds === null) return 'Use a duration such as 90m, 4h or 2d.'
  if (seconds < ttlLimits.min) return 'The time to live is at least 1 minute.'
  if (seconds > ttlLimits.max) return 'The time to live is at most 30 days.'
  return null
}

export const formatSpan = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${total % 60}s`
  return `${total}s`
}

export const secondsUntil = (iso: string | null | undefined, nowMs: number) => {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : Math.round((at - nowMs) / 1000)
}

export type Clock = { label: 'left' | 'until deletion'; text: string; urgent: boolean }

export const remaining = (sandbox: { status: string; stop_at: string | null; delete_at: string | null }, nowMs: number): Clock | null => {
  const stopped = sandbox.status === 'stopped' || sandbox.status === 'failed'
  const seconds = secondsUntil(stopped ? sandbox.delete_at : sandbox.stop_at, nowMs)
  if (seconds === null) return null
  if (stopped) return { label: 'until deletion', text: formatSpan(seconds), urgent: seconds < 86_400 }
  return { label: 'left', text: seconds <= 0 ? 'expiring' : formatSpan(seconds), urgent: seconds < 600 }
}

export const sizeText = (size: { cpu_millis: number; memory_bytes: number; disk_bytes: number }) => {
  const gib = (value: number) => `${Number((value / 1024 ** 3).toFixed(1))} GiB`
  return `${Number((size.cpu_millis / 1000).toFixed(2))} vCPU · ${gib(size.memory_bytes)} RAM · ${gib(size.disk_bytes)} disk`
}

export const imageText = (image: { ref: string | null }) => (image.ref === null ? 'toolchain' : image.ref)

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
  return { channel: view[0] ?? 0, bytes: view.subarray(1) }
}

export const forwardCommand = (sandboxId: string, port: number) => `sly sandbox forward ${sandboxId} ${port}`

export type DomainEntry = { domain: string; wildcard: boolean; ports: number[] }

export const parseAllowlist = (text: string): { entries: DomainEntry[]; problem: string | null } => {
  const entries: DomainEntry[] = []
  for (const raw of text.split(/\s+/)) {
    const line = raw.trim()
    if (!line) continue
    const [host = '', portText] = line.split(':')
    const wildcard = host.startsWith('*.')
    const domain = wildcard ? host.slice(2) : host
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) return { entries: [], problem: `${line} is not a domain name.` }
    const ports = portText ? portText.split(',').map(Number) : []
    if (ports.some(p => !Number.isInteger(p) || p < 1 || p > 65_535)) return { entries: [], problem: `${line} has a port outside 1 to 65535.` }
    entries.push({ domain: domain.toLowerCase(), wildcard, ports })
  }
  return { entries, problem: null }
}

export const allowlistText = (entries: DomainEntry[]) =>
  entries.map(e => `${e.wildcard ? '*.' : ''}${e.domain}${e.ports.length ? `:${e.ports.join(',')}` : ''}`).join('\n')
