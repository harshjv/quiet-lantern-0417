import type { ServerContext } from '@modelcontextprotocol/server'
import { defineTool, type Outcome, type Schema, type ToolDef } from '@stationly/mcp'
import { t as Type } from 'elysia'
import { apiFor, outcome, raw, type Session } from './api.ts'
import { invalid, must, Refusal, serviceId } from './refs.ts'

type Spec<S extends Schema> = Parameters<typeof defineTool<S, Session>>[0]

const tool = <S extends Schema>(spec: Spec<S>): ToolDef<Session> =>
  defineTool<S, Session>({
    ...spec,
    run: async (session, input, request) => {
      try {
        return await spec.run(session, input, request)
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, envelope: error.envelope }
        throw error
      }
    }
  })

const api = (session: Session, request: ServerContext, input?: { idempotency_key?: string }) => apiFor(session, request, input?.idempotency_key)
const ok = (body: unknown): Outcome => ({ ok: true, body })
const Int = (options: Record<string, unknown> = {}) => Type.Unsafe<number>({ type: 'integer', ...options })
const ServiceRef = Type.String({ minLength: 1, description: 'Service id (svc_...) or project/environment/service by name' })
const DeploymentId = Type.String({ pattern: '^dep_' })
const RunId = Type.String({ pattern: '^run_' })
const Fields = Type.Optional(Type.String({ description: 'Comma-separated fields to add to the summary, or *' }))
const maxToolLines = 200
const terminalRun = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

const progress = async (request: ServerContext, step: number, message: string) => {
  const progressToken = request.mcpReq._meta?.progressToken
  if (progressToken !== undefined) await request.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: step, message } })
}

type Line = { at: string; stream: string; role: string | null; text: string }
type Page = { lines: Line[]; next_cursor: string | null; truncated: boolean }

const logsOf = async (session: Session, request: ServerContext, query: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)]))
  return raw(session, request, `/v1/logs?${params}`)
}

const untrustedLogs = (page: Page, source: string) => ({
  untrusted: { source, text: page.lines.map(l => `${l.at}${l.role ? ` [${l.role}]` : ''} ${l.stream} ${l.text}`).join('\n') },
  line_count: page.lines.length,
  first_at: page.lines[0]?.at ?? null,
  last_at: page.lines.at(-1)?.at ?? null,
  next_cursor: page.next_cursor,
  truncated: page.truncated,
  paging: page.lines.length
    ? `Pass cursor=${page.next_cursor} to read lines written after these, or until=${page.lines[0]!.at} to read older lines.`
    : 'No lines matched; widen since or drop grep and level.'
})

const latestBuild = async (session: Session, request: ServerContext, service: string) => {
  const builds = must<{ items: { id: string }[] }>(await raw(session, request, `/v1/services/${service}/builds?limit=1`))
  return builds.items[0]?.id ?? invalid('/service', 'the service has no builds')
}

export const operationTools: Record<string, ToolDef<Session>> = {
  redeploy: tool({
    name: 'redeploy',
    title: 'Redeploy',
    description: "Redeploy the current deployment's image with the current variable versions (no build). NO_CURRENT_DEPLOYMENT when the service never deployed. Follow with wait_for_deployment.",
    family: 'write',
    level: 'deploy',
    input: Type.Object({ service: ServiceRef, supersede: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    run: async (session, input, request) =>
      outcome(await api(session, request, input).v1.services({ service: await serviceId(session, request, input.service) }).redeploy.post({ supersede: input.supersede }))
  }),
  rollback: tool({
    name: 'rollback',
    title: 'Roll back',
    description:
      'Roll a service back to a previous deployment (default the last superseded one): its image, variable snapshot and configuration. STALE_SECRETS_CONFIRM_REQUIRED lists keys whose pinned secret versions are older than the heads; repeat with confirm_stale_secrets true to accept them. IMAGE_PRUNED when Depot no longer holds the image.',
    family: 'destroy',
    level: 'deploy',
    input: Type.Object({ service: ServiceRef, deployment: Type.Optional(Type.String({ description: 'dep_... or the deployment number' })), confirm_stale_secrets: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    run: async (session, input, request) =>
      outcome(
        await api(session, request, input)
          .v1.services({ service: await serviceId(session, request, input.service) })
          .rollback.post({ deployment_id: input.deployment, confirm_stale_secrets: input.confirm_stale_secrets })
      )
  }),
  rebuild_service: tool({
    name: 'rebuild_service',
    title: 'Rebuild service',
    description: 'Rebuild from the same source (the last uploaded directory for local sources) with current base images, then deploy. SOURCE_UNREACHABLE when the source cannot be fetched.',
    family: 'write',
    level: 'deploy',
    input: Type.Object({ service: ServiceRef, supersede: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    run: async (session, input, request) =>
      outcome(await api(session, request, input).v1.services({ service: await serviceId(session, request, input.service) }).rebuild.post({ supersede: input.supersede }))
  }),
  wait_for_deployment: tool({
    name: 'wait_for_deployment',
    title: 'Wait for deployment',
    description:
      'Follow a deployment until it is active, failed or cancelled, or until timeout_s passes (default 600, max 3600). Returns { deployment, done, diagnosis? }; call again while done is false. Sends progress notifications with each status. A failed deployment carries its diagnosis.',
    family: 'read',
    level: 'read',
    alwaysLoad: true,
    input: Type.Object({ deployment: DeploymentId, timeout_s: Type.Optional(Int({ minimum: 0, maximum: 3600 })) }, { additionalProperties: false }),
    run: async (session, input, request) => {
      const deadline = Date.now() + (input.timeout_s ?? 600) * 1000
      const signal = request.mcpReq.signal
      let step = 0
      let last: string | null = null
      const first = must<{ status: string }>(outcome(await api(session, request).v1.deployments({ id: input.deployment }).get({ query: {} })))
      await progress(request, ++step, `deployment ${input.deployment} is ${first.status}; waiting up to ${input.timeout_s ?? 600} s`)
      for (;;) {
        const remaining = Math.max(0, Math.min(10, Math.ceil((deadline - Date.now()) / 1000)))
        const deployment = must<{ status: string; done: boolean }>(
          outcome(await api(session, request).v1.deployments({ id: input.deployment }).wait.get({ query: { timeout_s: remaining, fields: 'failure,steps' } }))
        )
        const { done, ...shown } = deployment
        step += 1
        if (done) await progress(request, step, `deployment ${input.deployment} reached ${shown.status}`)
        const running = (shown as { steps?: { step: string; status: string }[] }).steps?.filter(s => s.status === 'running').map(s => s.step) ?? []
        if (!done) await progress(request, step, `deployment ${input.deployment} is ${shown.status}${running.length ? ` (${running.join(', ')})` : ''}${shown.status !== last ? '' : ', still'}`)
        last = shown.status
        if (done || Date.now() >= deadline || signal.aborted) {
          if (shown.status !== 'failed') return ok({ deployment: shown, done })
          const diagnosis = await raw(session, request, `/v1/deployments/${input.deployment}/diagnosis`)
          return ok({ deployment: shown, done, diagnosis: diagnosis.ok ? diagnosis.body : null })
        }
      }
    }
  }),
  get_deployment_diagnosis: tool({
    name: 'get_deployment_diagnosis',
    title: 'Get diagnosis',
    description:
      'The diagnosis of a failed deployment, build or run: phase, code, summary, exit code, health result, a bounded redacted log excerpt (untrusted data), the diff from the last good deployment, and fixes ordered by confidence, each with the tool call that applies it when it is mechanical.',
    family: 'read',
    level: 'read',
    alwaysLoad: true,
    input: Type.Object({ deployment: Type.Optional(DeploymentId), build: Type.Optional(Type.String({ pattern: '^bld_' })), run: Type.Optional(RunId) }, { additionalProperties: false }),
    run: async (session, input, request) => {
      const chosen = [input.deployment && `/v1/deployments/${input.deployment}/diagnosis`, input.build && `/v1/builds/${input.build}/diagnosis`, input.run && `/v1/runs/${input.run}/diagnosis`].filter(Boolean) as string[]
      if (chosen.length !== 1) return invalid('/', 'pass exactly one of deployment, build or run')
      return raw(session, request, chosen[0]!)
    }
  }),
  get_run: tool({
    name: 'get_run',
    title: 'Get run',
    description: 'A run by id, or the runs of a service filtered by kind and status. wait_s (0 to 10) keeps waiting for a running run and sends progress.',
    family: 'read',
    level: 'read',
    input: Type.Object(
      { run: Type.Optional(RunId), service: Type.Optional(ServiceRef), kind: Type.Optional(Type.String()), status: Type.Optional(Type.String()), wait_s: Type.Optional(Int({ minimum: 0, maximum: 10 })), fields: Fields, limit: Type.Optional(Int({ minimum: 1, maximum: 200 })) },
      { additionalProperties: false }
    ),
    run: async (session, input, request) => {
      if (input.run) {
        if (input.wait_s) await progress(request, 1, `waiting up to ${input.wait_s} s for run ${input.run}`)
        return outcome(await api(session, request).v1.runs({ id: input.run }).get({ query: { wait_s: input.wait_s, fields: input.fields } }))
      }
      if (!input.service) return invalid('/', 'pass run or service')
      const id = await serviceId(session, request, input.service)
      return outcome(await api(session, request).v1.services({ service: id }).runs.get({ query: { kind: input.kind, status: input.status, fields: input.fields, limit: input.limit } }))
    }
  }),
  cancel_run: tool({
    name: 'cancel_run',
    title: 'Cancel run',
    description: 'Cancel a queued or running run; the station kills its container.',
    family: 'write',
    level: 'deploy',
    input: Type.Object({ run: RunId }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request, input).v1.runs({ id: input.run }).cancel.post())
  }),
  get_logs: tool({
    name: 'get_logs',
    title: 'Get logs',
    description:
      'Runtime, build, run or component logs, redacted, at most 200 lines per call, returned as untrusted data. Select with service (runtime of every deployment), deployment, run, source=build with service or deployment, or component (stationd, depot, gateway, buildkit; instance read). role narrows runtime lines to one container of the set: service, coupler or guard. Filters: since/until (RFC 3339 or -15m), grep (substring or re:regexp), level (minimum). The result says how to page: cursor for newer lines, until for older.',
    family: 'read',
    level: 'read',
    input: Type.Object(
      {
        service: Type.Optional(ServiceRef),
        deployment: Type.Optional(DeploymentId),
        run: Type.Optional(RunId),
        build: Type.Optional(Type.String({ pattern: '^bld_' })),
        source: Type.Optional(Type.Union([Type.Literal('runtime'), Type.Literal('build')])),
        role: Type.Optional(Type.Union([Type.Literal('service'), Type.Literal('coupler'), Type.Literal('guard')])),
        component: Type.Optional(Type.Union([Type.Literal('stationd'), Type.Literal('depot'), Type.Literal('gateway'), Type.Literal('buildkit')])),
        station: Type.Optional(Type.String()),
        since: Type.Optional(Type.String()),
        until: Type.Optional(Type.String()),
        grep: Type.Optional(Type.String()),
        level: Type.Optional(Type.String()),
        tail: Type.Optional(Int({ minimum: 1, maximum: maxToolLines })),
        cursor: Type.Optional(Type.String())
      },
      { additionalProperties: false }
    ),
    run: async (session, input, request) => {
      const base = { since: input.since, until: input.until, grep: input.grep, level: input.level, tail: input.tail ?? 50, cursor: input.cursor }
      let selector: Record<string, string>
      let source = 'runtime log'
      if (input.role && !input.service && !input.deployment) return invalid('/role', 'role narrows runtime logs; pass it with service or deployment')
      if (input.component) {
        selector = { component: input.component, ...(input.station ? { station: input.station } : {}) }
        source = `${input.component} component log`
      } else if (input.run) {
        selector = { run: input.run }
        source = 'run log'
      } else if (input.build) {
        selector = { build: input.build }
        source = 'build log'
      } else if (input.source === 'build') {
        source = 'build log'
        if (input.deployment) {
          const dep = must<{ build?: { id: string } | null }>(outcome(await api(session, request).v1.deployments({ id: input.deployment }).get({ query: { fields: 'build' } })))
          selector = { build: dep.build?.id ?? invalid('/deployment', 'the deployment has no build') }
        } else if (input.service) selector = { build: await latestBuild(session, request, await serviceId(session, request, input.service)) }
        else return invalid('/', 'source=build needs service, deployment or build')
      } else if (input.deployment) selector = { deployment: input.deployment, ...(input.role ? { role: input.role } : {}) }
      else if (input.service) selector = { service: await serviceId(session, request, input.service), ...(input.role ? { role: input.role } : {}) }
      else return invalid('/', 'pass service, deployment, run, build or component')
      const result = await logsOf(session, request, { ...selector, ...base })
      return result.ok ? ok({ ...untrustedLogs(result.body as Page, source), selector }) : result
    }
  }),
  get_metrics: tool({
    name: 'get_metrics',
    title: 'Get metrics',
    description: 'Live CPU percent, memory used and limit, network and block I/O rates and restart count of a service, from the latest 5-second sample.',
    family: 'read',
    level: 'read',
    input: Type.Object({ service: ServiceRef }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request).v1.services({ service: await serviceId(session, request, input.service) }).metrics.get())
  }),
  run_command: tool({
    name: 'run_command',
    title: 'Run command',
    description:
      "Run a one-off command in the service's current image and variables. With wait (default true) it returns when the run finishes or after 10 s, with the exit code and the last output lines as untrusted data, sending progress meanwhile. In a protected environment a non-human actor gets a staged_change.",
    family: 'write',
    level: 'deploy',
    input: Type.Object({ service: ServiceRef, command: Type.Array(Type.String(), { minItems: 1 }), wait: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    run: async (session, input, request) => {
      const id = await serviceId(session, request, input.service)
      const created = await api(session, request, input).v1.services({ service: id }).runs.post({ command: input.command, wait_s: 0 })
      if (created.error || created.status === 202 || input.wait === false) return outcome(created)
      const runId = (created.data as { id: string }).id
      const deadline = Date.now() + 10_000
      let current = created.data as { id: string; status: string; exit_code: number | null }
      let step = 0
      while (!terminalRun.has(current.status) && Date.now() < deadline && !request.mcpReq.signal.aborted) {
        await progress(request, ++step, `run ${runId} is ${current.status}`)
        current = must(outcome(await api(session, request).v1.runs({ id: runId }).get({ query: { wait_s: Math.max(1, Math.min(3, Math.ceil((deadline - Date.now()) / 1000))), fields: 'failure' } })))
      }
      if (!terminalRun.has(current.status)) return ok({ run: current, done: false, next: `call get_run with run=${runId} and wait_s=10` })
      const logs = await logsOf(session, request, { run: runId, tail: 50 })
      return ok({ run: current, done: true, output: logs.ok ? untrustedLogs(logs.body as Page, 'run output') : null })
    }
  }),
  get_events: tool({
    name: 'get_events',
    title: 'Get events',
    description:
      'Recent events (deployments, runs, health, stations, staged changes, notifications) visible to your scopes, newest first, filtered by types (comma list, deployment.* prefixes), project, environment and service. Pass since=<event id> for the events after it in order; next_since resumes. Retained 14 days.',
    family: 'read',
    level: 'read',
    input: Type.Object(
      {
        since: Type.Optional(Type.String({ pattern: '^evt_' })),
        types: Type.Optional(Type.String()),
        project: Type.Optional(Type.String()),
        environment: Type.Optional(Type.String()),
        service: Type.Optional(Type.String()),
        limit: Type.Optional(Int({ minimum: 1, maximum: 200 })),
        cursor: Type.Optional(Type.String()),
        fields: Fields
      },
      { additionalProperties: false }
    ),
    run: async (session, input, request) => outcome(await api(session, request).v1.events.get({ query: input }))
  }),
  update_station: tool({
    name: 'update_station',
    title: 'Update station',
    description:
      'Change a station; send at least one field. public_address is the IPv4 address its inbound 80, 443 and port allocations answer on. concurrency_cap (at least 1) is how many deployments it runs at once; the rest wait queued. draining true places no new deployments on the station and false ends the drain; the drain holds while the station is offline or asleep, and running services keep running. intermittent marks a station that is expected to go away, so it becomes asleep instead of offline. Every field reaches stationd in the next generation. Returns a staged_change when platform.protected is on.',
    family: 'write',
    level: 'admin',
    instance: true,
    input: Type.Object(
      {
        station: Type.String({ minLength: 1 }),
        public_address: Type.Optional(Type.String({ minLength: 1 })),
        concurrency_cap: Type.Optional(Type.Integer({ minimum: 1 })),
        draining: Type.Optional(Type.Boolean()),
        intermittent: Type.Optional(Type.Boolean())
      },
      { additionalProperties: false }
    ),
    run: async (session, input, request) => {
      const { station, ...fields } = input
      return outcome(await api(session, request, input).v1.stations({ station }).patch(fields))
    }
  }),
  remove_station: tool({
    name: 'remove_station',
    title: 'Remove station',
    description: 'Remove a station that runs no services. Its key is revoked and kept, so the station is told STATION_REVOKED on its next connection.',
    family: 'destroy',
    level: 'admin',
    instance: true,
    input: Type.Object({ station: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request, input).v1.stations({ station: input.station }).delete())
  }),
  list_notifications: tool({
    name: 'list_notifications',
    title: 'List notifications',
    description: 'Notification channels (webhooks in 1a) with filter, status and failing_since; fields=config shows URLs with secrets as { sealed: true }.',
    family: 'read',
    level: 'admin',
    instance: true,
    input: Type.Object({ status: Type.Optional(Type.String()), fields: Fields }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request).v1['notification-channels'].get({ query: { status: input.status, fields: input.fields } }))
  }),
  add_notification: tool({
    name: 'add_notification',
    title: 'Add notification',
    description:
      'Add a webhook channel, or change one when channel is given. Deliveries are POSTs signed with X-Stationly-Signature sha256=HMAC(body, secret); six attempts at 10 s, 1 min, 10 min, 1 h and 6 h. A generated secret is returned once. filter selects event types and project ids.',
    family: 'write',
    level: 'admin',
    instance: true,
    input: Type.Object(
      {
        channel: Type.Optional(Type.String({ pattern: '^ntf_' })),
        kind: Type.Optional(Type.Literal('webhook')),
        config: Type.Object({ url: Type.Optional(Type.String()), secret: Type.Optional(Type.String({ minLength: 16 })) }, { additionalProperties: false }),
        filter: Type.Optional(Type.Object({ types: Type.Optional(Type.Array(Type.String())), projects: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }))
      },
      { additionalProperties: false }
    ),
    run: async (session, input, request) => {
      const channels = api(session, request, input).v1['notification-channels']
      if (input.channel) return outcome(await channels({ id: input.channel }).patch({ config: input.config, filter: input.filter }))
      if (!input.config.url) return invalid('/config/url', 'required for a new channel')
      return outcome(await channels.post({ kind: input.kind ?? 'webhook', config: { url: input.config.url, secret: input.config.secret }, filter: input.filter }))
    }
  }),
  test_notification: tool({
    name: 'test_notification',
    title: 'Test notification',
    description: 'Send a signed test delivery to a channel and report delivered, status_code and duration; success returns a failing channel to active.',
    family: 'write',
    level: 'admin',
    instance: true,
    input: Type.Object({ channel: Type.String({ pattern: '^ntf_' }) }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request, input).v1['notification-channels']({ id: input.channel }).test.post())
  }),
  remove_notification: tool({
    name: 'remove_notification',
    title: 'Remove notification',
    description: 'Remove a notification channel.',
    family: 'destroy',
    level: 'admin',
    instance: true,
    input: Type.Object({ channel: Type.String({ pattern: '^ntf_' }) }, { additionalProperties: false }),
    run: async (session, input, request) => outcome(await api(session, request, input).v1['notification-channels']({ id: input.channel }).delete())
  })
}
