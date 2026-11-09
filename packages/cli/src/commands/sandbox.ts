import { createServer, type Socket } from 'node:net'
import type { Command } from 'commander'
import { action, collect, integer, seconds, type Options } from '../command.ts'
import { Exit, apiFailure, exitCodes, usage } from '../errors.ts'
import { connect, credentialHeaders, environmentId, projectRef, type Run, type Sent } from '../kit.ts'
import { human, print, progress } from '../output.ts'
import { followSse } from '../sse.ts'
import { explanationText, probeText } from './network.ts'

type Json = Record<string, unknown>

type SandboxRef = { id: string; name: string }

type LogLine = { at: string; role: string | null; stream: string; text: string }

type RunRow = { id: string; status: string; exit_code: number | null; failure?: { code?: string } | null }

const seg = encodeURIComponent

const units: Record<string, number> = { g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2 }

export const bytesOf = (value: string, flag: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim())
  const unit = match?.[2]?.toLowerCase() ?? ''
  if (!match || (unit !== '' && !(unit in units))) throw usage(`${value} is not a size for ${flag}.`, 'Pass bytes, or a number with GiB or MiB such as 8GiB; a bare number below 1000000 means GiB.')
  const amount = Number(match[1])
  const bytes = unit ? amount * units[unit]! : amount < 1_000_000 ? amount * units.gib! : amount
  return Math.round(bytes)
}

type EgressDomain = { domain: string; wildcard: boolean; ports?: number[] }

export const allowOf = (entry: string): EgressDomain => {
  const [host, portList] = entry.split(':') as [string, string | undefined]
  const wildcard = host.startsWith('*.')
  const domain = wildcard ? host.slice(2) : host
  if (!domain) throw usage(`${entry} names no domain.`, 'Write --allow example.com, --allow *.example.com or --allow example.com:443,22.')
  const ports = portList ? portList.split(',').map(p => integer(p)) : undefined
  return { domain, wildcard, ...(ports ? { ports } : {}) }
}

const egressOf = (options: Options) => {
  const allow = options.allow as string[] | undefined
  if (allow?.length && options.openEgress) throw usage('--allow and --open-egress contradict each other.', 'Pass one of them.')
  if (allow?.length) return { mode: 'allowlist' as const, domains: allow.map(allowOf) }
  if (options.openEgress) return { mode: 'open' as const }
  return undefined
}

const sizeOf = (options: Options) => {
  const size: Json = {}
  if (options.cpu !== undefined) size.cpu_millis = options.cpu
  if (options.memory !== undefined) size.memory_bytes = bytesOf(options.memory as string, '--memory')
  if (options.disk !== undefined) size.disk_bytes = bytesOf(options.disk as string, '--disk')
  return Object.keys(size).length ? size : undefined
}

const sent = async (run: Run, method: string, path: string, body?: unknown): Promise<Sent> => {
  const response = await run.raw(path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw apiFailure(response.status, data)
  return { status: response.status, data }
}

const defined = (values: Json) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))

const sandboxRef = async (run: Run, ref: string) => {
  if (ref.startsWith('sbx_')) return ref
  const project = await projectRef(run)
  const environment = await environmentId(run)
  return (await run.get<SandboxRef>(`/v1/projects/${seg(project)}/environments/${environment}/sandboxes/${seg(ref)}`)).id
}

const snapshotRef = async (run: Run, ref: string) => {
  if (ref.startsWith('sbs_')) return ref
  const environment = await environmentId(run)
  const list = await run.get<{ items: { id: string; name: string | null }[] }>(`/v1/environments/${environment}/sandbox-snapshots?limit=200`)
  const found = list.items.find(s => s.name === ref)
  if (!found) throw new Exit(exitCodes.api, { error: { code: 'NOT_FOUND', explanation: `The environment has no snapshot named ${ref}.`, fix: 'Run sly sandbox snapshots.' } })
  return found.id
}

const forkSource = async (run: Run, ref: string) => {
  if (ref.startsWith('sbs_')) return { snapshot: ref }
  if (ref.startsWith('sbx_')) return { sandbox: ref }
  try {
    return { sandbox: await sandboxRef(run, ref) }
  } catch (error) {
    if (!(error instanceof Exit) || error.envelope?.error.code !== 'NOT_FOUND') throw error
    return { snapshot: await snapshotRef(run, ref) }
  }
}

const renderList = (data: unknown) => {
  const { items } = data as { items: Json[] }
  return human({
    items: items.map(s => {
      const size = s.size as { cpu_millis: number; memory_bytes: number; disk_bytes: number }
      const image = s.image as { ref: string | null }
      return {
        name: s.name,
        status: s.status,
        image: image.ref ?? 'toolchain',
        size: `${size.cpu_millis}m ${Math.round(size.memory_bytes / 1024 ** 2)}MiB ${Math.round(size.disk_bytes / 1024 ** 3)}GiB`,
        network: s.network,
        stop_at: s.stop_at,
        delete_at: s.delete_at,
        id: s.id
      }
    })
  })
}

const attachUrl = (run: Run, path: string) => {
  const url = new URL(path, run.credentials.instance)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

const openSocket = (run: Run, url: URL) => {
  const ws = new WebSocket(url, { headers: { ...credentialHeaders(run.credentials, 'GET', url.href), 'user-agent': 'sly' } } as unknown as string[])
  ws.binaryType = 'arraybuffer'
  return ws
}

const bytesOfMessage = (data: unknown) => Buffer.from(data as ArrayBuffer)

const attachRun = (run: Run, created: { id: string; attach_url: string }, mode: { tty: boolean; stdin: boolean; json: boolean }) => {
  const url = attachUrl(run, created.attach_url)
  url.searchParams.set('rows', String(process.stdout.rows ?? 24))
  url.searchParams.set('cols', String(process.stdout.columns ?? 80))
  const ws = openSocket(run, url)
  const out = mode.json ? process.stderr : process.stdout
  return new Promise<{ status: string; exit_code: number | null } | null>(resolve => {
    let exit: { status: string; exit_code: number | null } | null = null
    const restore = () => {
      if (mode.tty && process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    ws.onopen = () => {
      if (mode.tty) process.stdin.setRawMode(true)
      if (mode.stdin) {
        process.stdin.on('data', (chunk: Buffer) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([0]), chunk])))
        process.stdin.on('end', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'eof' })))
        if (mode.tty) process.stdout.on('resize', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'resize', rows: process.stdout.rows, cols: process.stdout.columns })))
        process.stdin.resume()
      }
    }
    ws.onmessage = message => {
      if (typeof message.data === 'string') {
        const control = JSON.parse(message.data) as { type: string; status?: string; exit_code?: number | null; code?: string; explanation?: string }
        if (control.type === 'exit') exit = { status: control.status!, exit_code: control.exit_code ?? null }
        if (control.type === 'error') process.stderr.write(`error: ${control.explanation}\n${control.code}\n`)
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

const finishRun = async (run: Run, options: Options, id: string, exit: { status: string; exit_code: number | null } | null) => {
  if (!exit) return exitCodes.connection
  const row = (await sent(run, 'GET', `/v1/runs/${id}?wait_s=10&fields=failure`)).data as RunRow
  progress(`${row.id}: ${row.status}, exit code ${row.exit_code ?? exit.exit_code ?? '-'}`)
  if (options.json) process.stdout.write(`${JSON.stringify(row, null, 2)}\n`)
  if (row.status === 'succeeded') return exitCodes.ok
  process.stderr.write(`${row.failure?.code ?? 'EXIT_NONZERO'}\n`)
  return exitCodes.api
}

const showLine = (options: Options, line: LogLine) =>
  process.stdout.write(options.json ? `${JSON.stringify(line)}\n` : `${line.at} ${line.stream === 'stderr' ? 'E' : ' '} ${line.role ? `[${line.role}] ` : ''}${line.text}\n`)

const toSet = (options: Options, [key, value]: readonly [string, string]) => {
  if (options.sealed) return { key, kind: 'sealed' as const, value }
  if (value.includes('${{')) return { key, kind: 'reference' as const, reference: value }
  return { key, kind: 'literal' as const, value }
}

const pair = (assignment: string) => {
  const at = assignment.indexOf('=')
  if (at < 1) throw usage(`${assignment} has no value.`, `Write ${assignment.split('=')[0]}=<value>.`)
  return [assignment.slice(0, at), assignment.slice(at + 1)] as const
}

export const sandboxCommands = (program: Command) => {
  const sandbox = program.command('sandbox').description('Persistent Linux machines for agents, isolated with gVisor')

  sandbox
    .command('list')
    .description('Sandboxes of the selected environment')
    .option('--status <status>', 'comma list of statuses')
    .action(
      action(async options => {
        const run = await connect(options)
        const environment = await environmentId(run)
        const query = options.status ? `?status=${seg(options.status as string)}` : ''
        return print(options, await sent(run, 'GET', `/v1/environments/${environment}/sandboxes${query}`), renderList)
      })
    )

  sandbox
    .command('describe')
    .argument('<sandbox>', 'sandbox id or name')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'GET', `/v1/sandboxes/${await sandboxRef(run, ref!)}?fields=*`))
      })
    )

  const configure = (c: Command) =>
    c
      .option('--cpu <millis>', 'CPU in millicores', integer)
      .option('--memory <size>', 'memory in bytes, or MiB and GiB')
      .option('--disk <size>', 'disk limit in bytes, or MiB and GiB')
      .option('--allow <domain>', 'allow egress to domain[:port,...]; *.example.com allows its subdomains; repeatable', collect)
      .option('--ttl <duration>', 'time to live after each start, such as 2h', seconds)

  configure(
    sandbox
      .command('create')
      .description('Create and start a sandbox from the toolchain image or another image')
      .argument('[name]', 'sandbox name; the API names it when omitted')
      .option('--image <ref>', 'image reference; the toolchain image when omitted')
      .option('--station <station>', 'station id or name')
      .option('--network <mode>', 'isolated or environment')
      .option('--docker', 'start dockerd inside the sandbox')
      .option('--no-start', 'create the sandbox stopped')
  ).action(
    action(async (options, name) => {
      const run = await connect(options)
      const environment = await environmentId(run)
      if (options.network && !['isolated', 'environment'].includes(options.network as string)) throw usage(`--network ${options.network} is not isolated or environment.`, 'Pass --network isolated or --network environment.')
      const body = defined({
        name,
        image: options.image ? { ref: options.image } : undefined,
        station_id: options.station,
        size: sizeOf(options),
        network: options.network,
        docker: options.docker ? true : undefined,
        egress: egressOf(options),
        ttl_s: options.ttl,
        start: options.start === false ? false : undefined
      })
      return print(options, await sent(run, 'POST', `/v1/environments/${environment}/sandboxes`, body))
    })
  )

  configure(
    sandbox
      .command('fork')
      .description('Fork a sandbox or a snapshot into a new sandbox')
      .argument('<source>', 'sandbox or snapshot, by id or name')
      .argument('[name]', 'new sandbox name')
  ).action(
    action(async (options, source, name) => {
      const run = await connect(options)
      const from = await forkSource(run, source!)
      const target = await environmentId(run)
      const body = defined({ name, from, size: sizeOf(options), egress: egressOf(options), ttl_s: options.ttl })
      return print(options, await sent(run, 'POST', `/v1/environments/${target}/sandboxes`, body))
    })
  )

  configure(
    sandbox
      .command('update')
      .description('Change a sandbox; ttl extends from now')
      .argument('<sandbox>')
      .option('--docker', 'start dockerd inside the sandbox at its next start')
      .option('--no-docker', 'do not start dockerd')
      .option('--open-egress', 'allow every public destination')
  ).action(
    action(async (options, ref) => {
      const run = await connect(options)
      const body = defined({ size: sizeOf(options), egress: egressOf(options), ttl_s: options.ttl, docker: options.docker })
      return print(options, await sent(run, 'PATCH', `/v1/sandboxes/${await sandboxRef(run, ref!)}`, body))
    })
  )

  sandbox
    .command('start')
    .argument('<sandbox>')
    .option('--ttl <duration>', 'replaces the stored time to live', seconds)
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'POST', `/v1/sandboxes/${await sandboxRef(run, ref!)}/start`, defined({ ttl_s: options.ttl })))
      })
    )

  sandbox
    .command('stop')
    .argument('<sandbox>')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'POST', `/v1/sandboxes/${await sandboxRef(run, ref!)}/stop`))
      })
    )

  sandbox
    .command('delete')
    .description('Delete a sandbox and its disk; its snapshots stay')
    .argument('<sandbox>')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'DELETE', `/v1/sandboxes/${await sandboxRef(run, ref!)}`))
      })
    )

  sandbox
    .command('exec')
    .description('Run a command in a running sandbox and stream it; put the command after --')
    .argument('<sandbox>')
    .argument('<command...>')
    .option('--user <user>')
    .option('--cwd <dir>')
    .option('--env <pair>', 'KEY=VALUE for this command only; repeatable', collect)
    .option('--timeout <duration>', 'kill the command after this long', seconds)
    .option('--detach', 'create the exec and print the run without streaming')
    .action(
      action(async (options, ref, ...command) => {
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        const env = options.env ? Object.fromEntries((options.env as string[]).map(pair)) : undefined
        const detach = Boolean(options.detach)
        const body = defined({ command: command.flat(), user: options.user, cwd: options.cwd, env, timeout_s: options.timeout, attach: !detach, wait_s: detach ? 0 : undefined })
        const created = await sent(run, 'POST', `/v1/sandboxes/${id}/exec`, body)
        if (detach) return print(options, created)
        const row = created.data as { id: string; attach_url: string }
        const exit = await attachRun(run, row, { tty: false, stdin: !process.stdin.isTTY, json: Boolean(options.json) })
        return finishRun(run, options, row.id, exit)
      })
    )

  sandbox
    .command('shell')
    .description('Interactive shell in a running sandbox; needs a terminal and a human actor in protected environments')
    .argument('<sandbox>')
    .argument('[command...]')
    .option('--user <user>')
    .option('--cwd <dir>')
    .action(
      action(async (options, ref, ...command) => {
        if (!process.stdin.isTTY) throw usage('sly sandbox shell needs a terminal.', 'Run it from an interactive terminal; agents use sly sandbox exec.')
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        const argv = command.flat()
        const created = (await sent(run, 'POST', `/v1/sandboxes/${id}/shells`, defined({ command: argv.length ? argv : undefined, user: options.user, cwd: options.cwd }))).data as { id: string; attach_url: string }
        const exit = await attachRun(run, created, { tty: true, stdin: true, json: false })
        if (!exit) return exitCodes.connection
        progress(`${created.id}: ${exit.status}, exit code ${exit.exit_code ?? '-'}`)
        return exit.status === 'succeeded' ? exitCodes.ok : exitCodes.api
      })
    )

  sandbox
    .command('snapshot')
    .description("Take a snapshot of a sandbox's disk; files on the disk, credentials included, are copied into every snapshot and fork")
    .argument('<sandbox>')
    .option('--name <name>')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'POST', `/v1/sandboxes/${await sandboxRef(run, ref!)}/snapshots`, defined({ name: options.name })))
      })
    )

  sandbox
    .command('snapshots')
    .argument('[sandbox]')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const path = ref ? `/v1/sandboxes/${await sandboxRef(run, ref)}/snapshots` : `/v1/environments/${await environmentId(run)}/sandbox-snapshots`
        return print(options, await sent(run, 'GET', path))
      })
    )

  sandbox
    .command('snapshot-delete')
    .argument('<snapshot>')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'DELETE', `/v1/sandbox-snapshots/${await snapshotRef(run, ref!)}`))
      })
    )

  sandbox
    .command('logs')
    .description('Init log of a sandbox, or its runtime log with --runtime')
    .argument('<sandbox>')
    .option('--runtime', 'the runsc log instead of the init log')
    .option('--tail <n>', 'last N lines', integer)
    .option('-f, --follow', 'stream new lines')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const params = new URLSearchParams({ sandbox: await sandboxRef(run, ref!), role: options.runtime ? 'runtime' : 'init', ...(options.tail ? { tail: String(options.tail) } : {}) })
        if (options.follow) {
          params.set('follow', 'true')
          return followSse(
            async lastId => {
              const response = await run.raw(`/v1/logs?${params}`, { headers: { accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) } })
              if (!response.ok) throw apiFailure(response.status, await response.json().catch(() => null))
              return response
            },
            event => {
              if (event.event === 'log') showLine(options, JSON.parse(event.data) as LogLine)
              else if (event.event === 'end') return exitCodes.ok
              return undefined
            }
          )
        }
        const page = (await sent(run, 'GET', `/v1/logs?${params}`)).data as { lines: LogLine[] }
        for (const line of page.lines) showLine(options, line)
        return exitCodes.ok
      })
    )

  sandbox
    .command('network')
    .description('Live connections, refused attempts and the DNS log of a sandbox')
    .argument('<sandbox>')
    .option('--dns', 'the resolver log')
    .option('--refused', 'only the refused attempts')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        if (options.dns) return print(options, await sent(run, 'GET', `/v1/sandboxes/${id}/dns-log`))
        const result = await sent(run, 'GET', `/v1/sandboxes/${id}/connections`)
        if (!options.refused) return print(options, result)
        const refused = (result.data as { refused: Json[] }).refused
        return print(options, { status: result.status, data: options.json ? refused : { items: refused } })
      })
    )

  sandbox
    .command('explain')
    .description('Why a sandbox can or cannot reach a target, hop by hop with fixes: its allowlist, its resolver, the sandbox ruleset and, for a joined sandbox, the Switch and the target service. Sends no packet')
    .argument('<sandbox>')
    .requiredOption('--to <target>', 'a service, service:port, a .internal name, ipv4:port or hostname:port')
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--udp', 'judge UDP instead of TCP')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        const box = await run.get<{ environment_id: string }>(`/v1/sandboxes/${id}`)
        const query = new URLSearchParams({ from: id, to: options.to as string, protocol: options.udp ? 'udp' : 'tcp' })
        if (options.port !== undefined) query.set('port', String(options.port))
        return print(options, await sent(run, 'GET', `/v1/environments/${box.environment_id}/network/explain?${query}`), explanationText)
      })
    )

  sandbox
    .command('probe')
    .description("Ask the sandbox's resolver as the sandbox, or judge one TCP handshake with the sandbox ruleset and send it from the station when the ruleset accepts the destination")
    .argument('<sandbox>')
    .requiredOption('--to <target>', 'a service, a .internal name, an ipv4 address or a public hostname; host:port is accepted')
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--dns', 'send only the A query to the resolver')
    .option('--timeout <seconds>', 'seconds, 1 to 10 (default 3)', integer)
    .action(
      action(async (options, ref) => {
        const timeout = options.timeout as number | undefined
        if (timeout !== undefined && (timeout < 1 || timeout > 10)) throw usage('--timeout is 1 to 10 seconds.', 'sly sandbox probe dev --to example.com:443 --timeout 5')
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        return print(options, await sent(run, 'POST', `/v1/sandboxes/${id}/network/probe`, { to: options.to, ...(options.port !== undefined ? { port: options.port } : {}), kind: options.dns ? 'dns' : 'tcp', ...(timeout !== undefined ? { timeout_s: timeout } : {}) }), probeText)
      })
    )

  sandbox
    .command('forward')
    .description('Listen on 127.0.0.1 and forward to a port of a running sandbox')
    .argument('<sandbox>')
    .argument('<port>', 'port inside the sandbox', integer)
    .option('--local-port <port>', 'local port (default: the sandbox port when free)', integer)
    .action(
      action(async (options, ref, port) => {
        const run = await connect(options)
        const id = await sandboxRef(run, ref!)
        const remote = Number(port)
        const connections = new Set<Socket>()
        const server = createServer(socket => {
          connections.add(socket)
          const url = attachUrl(run, `/v1/sandboxes/${id}/forward`)
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
              if (control.type === 'error') progress(`forward failed: ${control.explanation}`)
              if (control.type === 'end' && control.reason) progress(`forward ended: ${control.reason}`)
              return
            }
            socket.write(bytesOfMessage(message.data).subarray(1))
          }
          ws.onclose = () => socket.end()
          ws.onerror = () => socket.destroy()
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
        const wanted = (options.localPort as number | undefined) ?? remote
        const bound = await listen(wanted).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && options.localPort === undefined) return listen(0)
          throw error
        })
        const address = `127.0.0.1:${bound}`
        process.stdout.write(options.json ? `${JSON.stringify({ local_address: address })}\n` : `${address}\n`)
        progress(`forwarding ${address} to port ${remote} of ${id}; press Ctrl-C to stop`)
        return new Promise<number>(resolve => {
          const stop = () => {
            for (const socket of connections) socket.destroy()
            server.close(() => resolve(exitCodes.ok))
          }
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
      })
    )

  const variables = sandbox.command('variables').description('Variables of a sandbox; prefer references to project and global variables')
  variables
    .command('list')
    .argument('<sandbox>')
    .option('--resolved', 'the resolved view with sources')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await sent(run, 'GET', `/v1/sandboxes/${await sandboxRef(run, ref!)}/variables${options.resolved ? '/resolved' : ''}`))
      })
    )
  variables
    .command('set')
    .argument('<sandbox>')
    .argument('<assignments...>', 'KEY=VALUE or KEY=${{project.KEY}}')
    .option('--sealed', 'store the values write-only')
    .option('--allow-unresolved', 'accept references that do not resolve yet')
    .action(
      action(async (options, ref, ...assignments) => {
        const run = await connect(options)
        const body = defined({ set: assignments.flat().map(a => toSet(options, pair(a))), allow_unresolved: options.allowUnresolved ? true : undefined })
        return print(options, await sent(run, 'PATCH', `/v1/sandboxes/${await sandboxRef(run, ref!)}/variables`, body))
      })
    )
  variables
    .command('unset')
    .argument('<sandbox>')
    .argument('<keys...>')
    .action(
      action(async (options, ref, ...keys) => {
        const run = await connect(options)
        return print(options, await sent(run, 'PATCH', `/v1/sandboxes/${await sandboxRef(run, ref!)}/variables`, { unset: keys.flat() }))
      })
    )

  const platform = program.commands.find(c => c.name() === 'platform')!
  const storage = platform.command('storage').description('The sandbox filesystem of a station')
  storage
    .command('grow')
    .description('Grow the sandbox filesystem to a new total size while sandboxes run')
    .requiredOption('--size <size>', 'new total size in bytes, or GiB')
    .option('--station <station>', 'station id or name; the only station that reports sandboxes when omitted')
    .action(
      action(async options => {
        const run = await connect(options)
        let station = options.station as string | undefined
        if (!station) {
          const list = await run.get<{ items: { id: string; name: string; capabilities?: { sandboxes?: unknown } | null }[] }>('/v1/stations?fields=capabilities')
          const capable = list.items.filter(s => s.capabilities?.sandboxes)
          if (capable.length !== 1) throw usage(`${capable.length} stations report the sandbox capability.`, 'Pass --station <station>.')
          station = capable[0]!.id
        }
        return print(options, await sent(run, 'POST', `/v1/stations/${seg(station)}/sandbox-storage/grow`, { size_bytes: bytesOf(options.size as string, '--size') }))
      })
    )

  for (const command of [sandbox, variables, storage]) {
    command.exitOverride()
    for (const sub of command.commands) sub.exitOverride()
  }
}
