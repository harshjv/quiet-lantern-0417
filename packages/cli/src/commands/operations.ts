import type { Command } from 'commander'
import { action, collect, integer, seconds, type Options } from '../command.ts'
import { Exit, apiFailure, exitCodes, usage, type EnvelopeCode } from '../errors.ts'
import { connect, credentialHeaders, environmentId, isId, projectRef, send, serviceId, type Run } from '../kit.ts'
import { human, print, progress } from '../output.ts'
import { reportRun, waitRun, type RunRow } from '../runs.ts'
import { uploadAndDeploy } from '../push.ts'
import { followSse, readSse } from '../sse.ts'
import { follow } from './resources.ts'

type LogLine = { at: string; role: string | null; stream: string; level: string | null; text: string; cursor?: string }


const group = (program: Command, name: string) => program.commands.find(c => c.name() === name)!

const deploymentId = async (run: Run, ref: string) => {
  if (isId('deployment', ref)) return ref
  if (!/^\d+$/.test(ref)) throw usage(`${ref} is not a deployment id or number.`, 'Pass dep_... or the deployment number shown by sly deployments list.')
  const service = await serviceId(run)
  const list = await run.get<{ items: { id: string; number: number }[] }>(`/v1/services/${service}/deployments?limit=200`)
  const found = list.items.find(d => d.number === Number(ref))
  if (!found) throw new Exit(exitCodes.api, { error: { code: 'NOT_FOUND', explanation: `The service has no deployment ${ref} among its last 200.`, fix: 'Run sly deployments list.' } })
  return found.id
}

const query = (values: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(Object.entries(values).filter((e): e is [string, string | number | boolean] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString()

const showLine = (options: Options, line: LogLine, sink: NodeJS.WriteStream = process.stdout) =>
  sink.write(options.json ? `${JSON.stringify(line)}\n` : `${line.at} ${line.stream === 'stderr' ? 'E' : ' '} ${line.role && line.role !== 'service' ? `[${line.role}] ` : ''}${line.text}\n`)

const failIfNotOk = async (response: Response) => {
  if (response.ok) return response
  throw apiFailure(response.status, await response.json().catch(() => null))
}

const deployWith = (program: Command, name: string, describe: string, call: (run: Run, service: string, options: Options, ref?: string) => ReturnType<typeof send>, configure: (c: Command) => Command = c => c) =>
  configure(
    program
      .command(name)
      .description(describe)
      .option('--wait', 'follow the deployment until it is active or failed')
      .option('--timeout <duration>', 'how long --wait follows', seconds, 600)
  ).action(
    action(async (options, ref) => {
      const run = await connect(options)
      const sent = await call(run, await serviceId(run), options, ref)
      return options.wait ? follow(run, sent, options.timeout as number) : print(options, sent)
    })
  )

const sseHeaders = (lastId: string | null): Record<string, string> => ({ accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) })

const streamLogs = (run: Run, options: Options, params: Record<string, string | number | boolean | undefined>, sink: NodeJS.WriteStream = process.stdout) =>
  followSse(
    async lastId => failIfNotOk(await run.raw(`/v1/logs?${query({ ...params, follow: true })}`, { headers: sseHeaders(lastId) })),
    event => {
      if (event.event === 'log') showLine(options, JSON.parse(event.data) as LogLine, sink)
      else if (event.event === 'end') {
        progress(`log stream ended: ${(JSON.parse(event.data) as { reason: string }).reason}`)
        return exitCodes.ok
      } else if (event.event === 'error') {
        const e = JSON.parse(event.data) as { code: EnvelopeCode; explanation: string }
        throw new Exit(exitCodes.api, { error: { code: e.code, explanation: e.explanation, fix: 'Retry when the station is connected.' } })
      }
      return undefined
    }
  )

export const operationCommands = (program: Command) => {
  deployWith(program, 'redeploy', "Redeploy the current deployment's image with current variables", (run, service, options) =>
    send(run.api.v1.services({ service }).redeploy.post({ supersede: options.supersede as boolean | undefined }))
  , c => c.option('--supersede', 'cancel an in-flight deployment before cutover'))

  deployWith(
    program,
    'rollback',
    'Roll back to a previous deployment (default: the last superseded one)',
    async (run, service, options, ref) =>
      send(run.api.v1.services({ service }).rollback.post({ deployment_id: ref ? await deploymentId(run, ref) : undefined, confirm_stale_secrets: options.confirmStaleSecrets as boolean | undefined })),
    c => c.argument('[deployment]', 'dep_... or deployment number').option('--confirm-stale-secrets', 'roll back even though pinned secret versions are older than the heads')
  )

  deployWith(group(program, 'services'), 'rebuild', 'Rebuild from the same source and deploy', (run, service, options) =>
    send(run.api.v1.services({ service }).rebuild.post({ supersede: options.supersede as boolean | undefined }))
  , c => c.option('--supersede', 'cancel an in-flight deployment before cutover'))

  group(program, 'deployments')
    .command('diagnosis')
    .argument('<deployment>', 'dep_... or deployment number')
    .description('The diagnosis object of a failed deployment')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.deployments({ id: await deploymentId(run, ref!) }).diagnosis.get()))
      })
    )

  const builds = program.command('builds').description('Builds of a service')
  builds
    .command('list')
    .option('--status <status>')
    .option('--limit <n>', 'page size', integer)
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.services({ service: await serviceId(run) }).builds.get({ query: { status: options.status as string | undefined, limit: options.limit as number | undefined } })))
      })
    )
  builds
    .command('describe')
    .argument('<build>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.builds({ id: id! }).get({ query: { fields: 'detail,attestations' } })))
      })
    )

  program
    .command('logs')
    .description('Logs of the selected service, a deployment, its build, a run, or a platform component')
    .option('--build', 'build logs (of --deployment, or the latest build)')
    .option('--role <role>', 'runtime lines of one container of the set: service, coupler or guard')
    .option('--component <component>', 'platform component logs: stationd, depot, gateway or buildkit')
    .option('--station <station>', 'with --component: the station to read (default the one hosting Dispatch)')
    .option('--runtime', 'runtime logs (default)')
    .option('--deployment <n>', 'dep_... or deployment number')
    .option('--run <run>', 'a run id')
    .option('--since <time>', 'RFC 3339 or relative such as 10m or -1h')
    .option('--until <time>', 'RFC 3339 or relative')
    .option('--tail <n>', 'last N lines (default 50, max 5000)', integer)
    .option('--grep <text>', 'case-insensitive substring, or re:<regexp>')
    .option('--level <level>', 'minimum parsed level')
    .option('--cursor <cursor>', 'next_cursor from a previous page')
    .option('-f, --follow', 'stream new lines')
    .action(
      action(async options => {
        const run = await connect(options)
        let selector: Record<string, string>
        const role = options.role as string | undefined
        if (role && !['service', 'coupler', 'guard'].includes(role)) throw usage(`--role ${role} is not service, coupler or guard.`, 'sly logs --role coupler')
        if (role && (options.run || options.build || options.component)) throw usage('--role narrows runtime logs only.', 'Pass --role with the selected service or --deployment.')
        if (options.component) selector = { component: options.component as string, ...(options.station ? { station: options.station as string } : {}) }
        else if (options.run) selector = { run: options.run as string }
        else if (options.build) {
          if (options.deployment) {
            const dep = await run.get<{ build?: { id: string } | null }>(`/v1/deployments/${await deploymentId(run, options.deployment as string)}?fields=build`)
            if (!dep.build) throw usage('That deployment has no build.', 'Pick a deployment of a source service.')
            selector = { build: dep.build.id }
          } else {
            const list = await run.get<{ items: { id: string }[] }>(`/v1/services/${await serviceId(run)}/builds?limit=1`)
            if (!list.items[0]) throw usage('The service has no builds.', 'Deploy a source service first.')
            selector = { build: list.items[0].id }
          }
        } else if (options.deployment) selector = { deployment: await deploymentId(run, options.deployment as string), ...(role ? { role } : {}) }
        else selector = { service: await serviceId(run), ...(role ? { role } : {}) }
        const params = { ...selector, since: options.since as string | undefined, until: options.until as string | undefined, tail: options.tail as number | undefined, grep: options.grep as string | undefined, level: options.level as string | undefined, cursor: options.cursor as string | undefined }
        if (options.follow) return streamLogs(run, options, params)
        const page = (await (await failIfNotOk(await run.raw(`/v1/logs?${query(params)}`))).json()) as { untrusted: { lines: LogLine[] }; next_cursor: string | null; truncated: boolean }
        for (const line of page.untrusted.lines) showLine(options, line)
        if (!options.json && page.next_cursor) progress(`next: --cursor ${page.next_cursor}`)
        if (page.truncated) progress('the cursor pointed at a deleted segment; reading started at the oldest line')
        return exitCodes.ok
      })
    )

  program
    .command('metrics')
    .description('Live metrics of the selected service, or of every running service in the environment with --watch')
    .option('--watch', 'stream a sample every 5 s')
    .action(
      action(async options => {
        const run = await connect(options)
        if (!options.watch) return print(options, await send(run.api.v1.services({ service: await serviceId(run) }).metrics.get()))
        const environment = await environmentId(run)
        const only = run.selection.service ? await serviceId(run) : null
        const response = await failIfNotOk(await run.raw(`/v1/environments/${environment}/metrics`, { headers: { accept: 'text/event-stream' } }))
        for await (const event of readSse(response)) {
          if (event.event !== 'metrics') continue
          const sample = JSON.parse(event.data) as Record<string, unknown>
          if (only && sample.service_id !== only) continue
          process.stdout.write(
            options.json
              ? `${event.data}\n`
              : `${sample.at} ${sample.service_id} cpu ${Number(sample.cpu_pct).toFixed(2)}% mem ${sample.memory_bytes}/${sample.memory_limit_bytes} net rx ${sample.net_rx_bps} B/s tx ${sample.net_tx_bps} B/s blk r ${sample.blk_read_bps} w ${sample.blk_write_bps} restarts ${sample.restarts}\n`
          )
        }
        return exitCodes.ok
      })
    )

  program
    .command('run')
    .description("Run a one-off command in the service's image and variables; put the command after --")
    .argument('<command...>')
    .option('--detach', 'return once the run is created')
    .action(
      action(async (options, ...command) => {
        const run = await connect(options)
        const service = await serviceId(run)
        const argv = command.flat()
        const sent = await send(run.api.v1.services({ service }).runs.post({ command: argv, wait_s: 0 }))
        if (sent.status === 202 || options.detach) return print(options, sent)
        const created = sent.data as RunRow
        progress(`${created.id}: ${created.status}`)
        await streamLogs(run, { ...options, json: false }, { run: created.id, tail: 5000 }, options.json ? process.stderr : process.stdout).catch(error => {
          progress(`log stream unavailable: ${(error as Error).message}`)
        })
        const row = await waitRun(created, async () => (await send(run.api.v1.runs({ id: created.id }).get({ query: { wait_s: 10, fields: 'failure' } }))).data as RunRow)
        return reportRun(options, row)
      })
    )

  const runs = program.command('runs').description('Runs of a service')
  runs
    .command('list')
    .option('--kind <kind>')
    .option('--status <status>')
    .option('--limit <n>', 'page size', integer)
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.services({ service: await serviceId(run) }).runs.get({ query: { kind: options.kind as string | undefined, status: options.status as string | undefined, limit: options.limit as number | undefined } })))
      })
    )
  runs
    .command('describe')
    .argument('<run>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.runs({ id: id! }).get({ query: { fields: 'failure' } })))
      })
    )
  runs
    .command('cancel')
    .argument('<run>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.runs({ id: id! }).cancel.post()))
      })
    )

  program
    .command('shell')
    .description('Interactive shell in a fresh run of the service; a human actor is required in protected environments')
    .option('--command <arg>', 'command argument, repeatable (default /bin/sh)', collect)
    .option('--no-tty', 'no terminal, for scripted input')
    .action(
      action(async options => {
        const run = await connect(options)
        const service = await serviceId(run)
        const tty = options.tty !== false && Boolean(process.stdin.isTTY)
        const created = (await send(run.api.v1.services({ service }).shells.post({ command: options.command as string[] | undefined, tty }))).data as { id: string; attach_url: string }
        const url = new URL(created.attach_url, run.credentials.instance)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('rows', String(process.stdout.rows ?? 24))
        url.searchParams.set('cols', String(process.stdout.columns ?? 80))
        const ws = new WebSocket(url, { headers: { ...credentialHeaders(run.credentials, 'GET', url.href), 'user-agent': 'sly' } } as unknown as string[])
        ws.binaryType = 'arraybuffer'
        return new Promise<number>(resolve => {
          let exit: { status: string; exit_code: number | null } | null = null
          const restore = () => {
            if (tty && process.stdin.isTTY) process.stdin.setRawMode(false)
            process.stdin.pause()
          }
          ws.onopen = () => {
            if (tty) process.stdin.setRawMode(true)
            process.stdin.on('data', (chunk: Buffer) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([0]), chunk])))
            process.stdin.on('end', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'eof' })))
            process.stdout.on('resize', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'resize', rows: process.stdout.rows, cols: process.stdout.columns })))
            process.stdin.resume()
          }
          ws.onmessage = message => {
            if (typeof message.data === 'string') {
              const control = JSON.parse(message.data) as { type: string; status?: string; exit_code?: number | null; code?: string; explanation?: string; run_id?: string }
              if (control.type === 'attached') progress(`attached to ${control.run_id}`)
              if (control.type === 'exit') exit = { status: control.status!, exit_code: control.exit_code ?? null }
              if (control.type === 'error') process.stderr.write(`error: ${control.explanation}\n${control.code}\n`)
              return
            }
            const bytes = Buffer.from(message.data as ArrayBuffer)
            ;(bytes[0] === 2 ? process.stderr : process.stdout).write(bytes.subarray(1))
          }
          ws.onclose = () => {
            restore()
            if (!exit) return resolve(exitCodes.connection)
            progress(`${created.id}: ${exit.status}, exit code ${exit.exit_code ?? '-'}`)
            resolve(exit.status === 'succeeded' ? exitCodes.ok : exitCodes.api)
          }
          ws.onerror = () => progress('the attach connection failed')
        })
      })
    )

  program
    .command('push')
    .description('Upload a local directory (honoring .dockerignore) as the service source and deploy it')
    .argument('[path]', 'directory to push', '.')
    .option('--via <transport>', 'ssh lands the tarball on the station directly')
    .option('--wait', 'follow the deployment until it is active or failed')
    .option('--timeout <duration>', 'how long --wait follows', seconds, 600)
    .action(
      action(async (options, path) => {
        if (options.via === 'ssh')
          throw new Exit(exitCodes.usage, { error: { code: 'VALIDATION_FAILED', explanation: 'sly push --via ssh is not available in this release; the HTTPS upload to the API host is the supported transport.', fix: 'Run sly push without --via against a directly reachable API host.' } })
        const run = await connect(options)
        const service = await serviceId(run)
        const result = await uploadAndDeploy(run, service, path ?? '.', progress)
        if (result.status >= 400) throw apiFailure(result.status, result.body)
        const sent = { status: result.status, data: result.body }
        return options.wait ? follow(run, sent, options.timeout as number) : print(options, sent)
      })
    )

  program
    .command('events')
    .description('Events visible to you; -f follows the stream and resumes after --since')
    .option('--since <event id>', 'resume after this event id')
    .option('--types <types>', 'comma list, prefixes with *')
    .option('--limit <n>', 'page size', integer)
    .option('--fields <fields>', 'fields beyond the summary, such as delivered')
    .option('-f, --follow', 'stream events')
    .action(
      action(async options => {
        const run = await connect(options)
        const filter = {
          since: options.since as string | undefined,
          types: options.types as string | undefined,
          project: run.selection.project && !run.selection.service ? (await run.get<{ id: string }>(`/v1/projects/${encodeURIComponent(await projectRef(run))}`)).id : undefined,
          service: run.selection.service ? await serviceId(run) : undefined,
          limit: options.limit as number | undefined,
          fields: options.fields as string | undefined
        }
        if (!options.follow) {
          const sent = await send(run.api.v1.events.get({ query: filter }))
          if (options.json) return print(options, sent)
          process.stdout.write(`${human(sent.data)}\n`)
          const next = (sent.data as { next_since?: string | null }).next_since
          if (next) progress(`resume: --since ${next}`)
          return exitCodes.ok
        }
        const resumeFrom = filter.since ?? (await run.get<{ next_since: string | null }>('/v1/events?limit=1')).next_since
        let opened = false
        return followSse(
          async lastId => {
            const headers = sseHeaders(lastId ?? (opened ? resumeFrom : null))
            opened = true
            return failIfNotOk(await run.raw(`/v1/events?${query(filter)}`, { headers }))
          },
          event => {
            const row = JSON.parse(event.data) as { id: string; type: string; created_at: string; subject: { entity: string; id: string }; payload: Record<string, unknown> }
            process.stdout.write(options.json ? `${event.data}\n` : `${row.created_at} ${row.id} ${row.type} ${row.subject.entity}:${row.subject.id} ${JSON.stringify(row.payload)}\n`)
            return undefined
          }
        )
      })
    )

  const notifications = program.command('notifications').description('Notification channels (webhooks in 1a)')
  notifications.command('list').action(
    action(async options => {
      const run = await connect(options)
      return print(options, await send(run.api.v1['notification-channels'].get({ query: { fields: 'config' } })))
    })
  )
  notifications
    .command('add')
    .option('--url <url>', 'webhook URL')
    .option('--secret <secret>', 'HMAC secret (generated and shown once when omitted)')
    .option('--types <types>', 'comma list of event types, prefixes with *')
    .option('--projects <ids>', 'comma list of project ids')
    .option('--channel <channel>', 'update this channel instead of adding one')
    .action(
      action(async options => {
        const run = await connect(options)
        const split = (v: unknown) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined)
        const filter = options.types || options.projects ? { types: split(options.types), projects: split(options.projects) } : undefined
        const config = { url: options.url as string | undefined, secret: options.secret as string | undefined }
        if (options.channel) return print(options, await send(run.api.v1['notification-channels']({ id: options.channel as string }).patch({ config, filter })))
        if (!config.url) throw usage('A webhook needs --url.', 'Pass --url https://...')
        return print(options, await send(run.api.v1['notification-channels'].post({ kind: 'webhook', config: { url: config.url, secret: config.secret }, filter })))
      })
    )
  notifications
    .command('test')
    .argument('<channel>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1['notification-channels']({ id: id! }).test.post()))
      })
    )
  notifications
    .command('remove')
    .argument('<channel>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1['notification-channels']({ id: id! }).delete()))
      })
    )

  group(program, 'stations')
    .command('remove')
    .argument('<station>')
    .description('Remove a station with no services; it is told STATION_REVOKED on its next connection')
    .action(
      action(async (options, station) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.stations({ station: station! }).delete()))
      })
    )
}
