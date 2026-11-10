import type { Command } from 'commander'
import { action, collect, integer, seconds } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { actorTypeValues } from '@stationly/protocol'
import { connect, environmentId, isLevel, send, type Sent } from '../kit.ts'
import { acrossOutage } from '../outage.ts'
import { print } from '../output.ts'

const actorTypes = new Set<string>(actorTypeValues)

export const parseScope = (spec: string) => {
  const [project_id, environment_id, level] = spec.split(':')
  if (!project_id || !environment_id || !level || !isLevel(level)) throw usage(`${spec} is not a scope.`, 'Write project:environment:level with ids or *, such as prj_1:*:deploy.')
  return { project_id, environment_id, level }
}

export const adminCommands = (program: Command) => {
  const staged = program.command('staged').description('Staged changes')
  staged
    .command('list')
    .option('--status <status>', 'staged (default), accepted, rejected or superseded')
    .option('--platform', 'instance-scoped (platform) changes rather than the selected environment')
    .action(
      action(async options => {
        const run = await connect(options)
        const query = { status: options.status as string | undefined }
        if (options.platform || (!run.selection.project && !run.selection.environment))
          return print(options, await send(run.api.v1['staged-changes'].get({ query: { ...query, scope: 'instance' } })))
        return print(options, await send(run.api.v1.environments({ environment: await environmentId(run) })['staged-changes'].get({ query })))
      })
    )
  staged
    .command('accept')
    .argument('<staged-change>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1['staged-changes']({ id: id! }).accept.post()))
      })
    )
  staged
    .command('reject')
    .argument('<staged-change>')
    .option('--reason <reason>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1['staged-changes']({ id: id! }).reject.post({ reason: options.reason as string | undefined })))
      })
    )

  const stations = program.command('stations').description('Stations')
  stations
    .command('list')
    .option('--status <status>')
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.stations.get({ query: { status: options.status as string | undefined } })))
      })
    )
  stations
    .command('describe')
    .argument('<station>')
    .action(
      action(async (options, station) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.stations({ station: station! }).get({ query: { fields: '*' } })))
      })
    )
  stations
    .command('add')
    .argument('<name>')
    .option('--intermittent', 'the station sleeps and wakes')
    .action(
      action(async (options, name) => {
        const run = await connect(options)
        const sent = await send(run.api.v1.stations.post({ name: name!, intermittent: options.intermittent as boolean | undefined }))
        if (!options.json) process.stderr.write(`run on the new host within 15 minutes:\n  ${(sent.data as { command: string }).command}\n`)
        return print(options, sent)
      })
    )
  stations
    .command('update')
    .argument('<station>')
    .option('--public-address <ipv4>', 'the IPv4 address inbound 80, 443 and port allocations answer on')
    .option('--concurrency-cap <n>', 'deployments the station runs at once', integer)
    .option('--draining', 'place no new deployments on the station')
    .option('--no-draining', 'end the drain')
    .option('--intermittent', 'the station is expected to go away, as a gaming PC does')
    .option('--no-intermittent', 'the station is expected to stay online')
    .action(
      action(async (options, station) => {
        const run = await connect(options)
        const body = {
          public_address: options.publicAddress as string | undefined,
          concurrency_cap: options.concurrencyCap as number | undefined,
          draining: options.draining as boolean | undefined,
          intermittent: options.intermittent as boolean | undefined
        }
        return print(options, await send(run.api.v1.stations({ station: station! }).patch(body)))
      })
    )

  const tokens = program.command('tokens').description('Tokens')
  tokens
    .command('list')
    .option('--kind <kind>')
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.tokens.get({ query: { kind: options.kind as string | undefined } })))
      })
    )
  tokens
    .command('create')
    .argument('<name>')
    .option('--scope <project:environment:level>', 'scope, repeatable; ids or *', collect)
    .option('--ttl <duration>', 'lifetime, such as 1h or 30d', seconds)
    .option('--personal', 'a personal token (human actor only)')
    .action(
      action(async (options, name) => {
        const run = await connect(options)
        const scopes = (options.scope as string[] | undefined)?.map(parseScope)
        if (!options.personal && !scopes) throw usage('A scoped token needs at least one scope.', 'Pass --scope project:environment:level.')
        const sent: Sent = await send(
          run.api.v1.tokens.post({ name: name!, kind: options.personal ? 'personal' : 'scoped', scopes, expires_in_s: options.ttl as number | undefined })
        )
        if (!options.json) process.stderr.write('the key is shown once; store it now\n')
        return print(options, sent)
      })
    )
  tokens
    .command('revoke')
    .argument('<token>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.tokens({ id: id! }).delete()))
      })
    )
  tokens
    .command('renew')
    .argument('<token>')
    .option('--ttl <duration>', 'new lifetime from now, at most 1 year', seconds)
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.tokens({ id: id! }).renew.post({ expires_in_s: options.ttl as number | undefined })))
      })
    )

  const settings = program.command('settings').description('Instance settings')
  settings
    .command('get')
    .argument('[key]', 'a key or a prefix such as ipam.')
    .action(
      action(async (options, key) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.settings.get({ query: { prefix: key } })))
      })
    )
  settings
    .command('set')
    .argument('<key>')
    .argument('<value>', 'JSON value, or a plain string')
    .option('--reset-passkeys', 'allow a hostname change that needs a new passkey RP ID (human actor only)')
    .action(
      action(async (options, key, value) => {
        const run = await connect(options)
        const parsed = (() => { try { return JSON.parse(value!) as unknown } catch { return value } })()
        return print(options, await send(run.api.v1.settings.patch({ [key!]: parsed }, { query: { reset_passkeys: options.resetPasskeys ? true : undefined } })))
      })
    )

  program
    .command('audit')
    .description('Audit trail, newest first')
    .option('--since <time>', 'RFC 3339 or relative such as 10m or -1h')
    .option('--until <time>')
    .option('--actor <actor>', 'actor type (user, token, oauth_client, station, system) or actor id')
    .option('--action <prefix>', 'action prefix such as secret.')
    .option('--limit <n>', 'page size (max 200)', integer)
    .option('--cursor <cursor>')
    .action(
      action(async options => {
        const run = await connect(options)
        const actor = options.actor as string | undefined
        return print(
          options,
          await send(
            run.api.v1.audit.get({
              query: {
                since: options.since as string | undefined,
                until: options.until as string | undefined,
                actor_type: actor && actorTypes.has(actor) ? actor : undefined,
                actor_id: actor && !actorTypes.has(actor) ? actor : undefined,
                action: options.action as string | undefined,
                limit: options.limit as number | undefined,
                cursor: options.cursor as string | undefined
              }
            })
          )
        )
      })
    )

  const platform = program.command('platform').description('Lockfile, signatures, inventory and releases')
  platform
    .command('inventory')
    .description('Components with versions, digests, signatures and drift; base images with their last check')
    .option('--station <station>')
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.inventory.get({ query: { station: options.station as string | undefined } })), renderInventory)
      })
    )
  platform
    .command('doctor')
    .description('Health report: each check ok, warn or fail with a finding, a code and a fix')
    .option('--station <station>')
    .option('--checks <names>', 'comma-separated check names')
    .action(
      action(async options => {
        const run = await connect(options)
        const sent = await send(run.api.v1.doctor.get({ query: { station: options.station as string | undefined, checks: options.checks as string | undefined } }))
        print(options, sent, renderDoctor)
        const status = (sent.data as { status: string }).status
        return status === 'fail' ? exitCodes.api : exitCodes.ok
      })
    )
  platform
    .command('check')
    .description('Releases newer than the pinned one (only while platform.release_check is true)')
    .action(
      action(async options => {
        const run = await connect(options)
        const sent = await send(run.api.v1.platform.releases.get())
        if (!options.json && !(sent.data as { enabled: boolean }).enabled) {
          process.stdout.write('release check disabled\n')
          return 0
        }
        return print(options, sent)
      })
    )
  platform
    .command('upgrade')
    .description('Override one component by digest, or reset its override; --plan prints the diff without staging')
    .argument('[component]')
    .option('--version <version>')
    .option('--digest <digest>')
    .option('--reason <text>')
    .option('--reset', 'remove the override for <component>')
    .option('--station <station>')
    .option('--plan', 'print the diff and the signature checks without staging')
    .option('--wait', 'wait until the upgrade is done, failed or reverted')
    .option('--timeout <duration>', 'with --wait, give up after this long', seconds, 900)
    .action(
      action(async (options, component) => {
        const run = await connect(options)
        if (!component) {
          if (!options.version) throw usage('Name a component, or --version for a release.', 'sly platform upgrade <component> --version <v> --digest <sha256:...>')
          const sent = await send(run.api.v1.platform.upgrade.post({ version: options.version as string, station: options.station as string | undefined, plan: Boolean(options.plan) }))
          const code = print(options, sent, renderUpgrade)
          const upgradeId = (sent.data as { upgrade?: string | null }).upgrade
          if (!options.wait || !upgradeId) return code
          return waitUpgrade(options, () => send(run.api.v1.inventory.get({ query: {} })), upgradeId, (options.timeout as number) * 1000)
        }
        const override = options.reset
          ? { reset: true as const }
          : (() => {
              if (!options.version || !options.digest) throw usage('An override needs --version and --digest.', 'sly platform upgrade gateway --version 3.7.18 --digest sha256:...')
              return { version: options.version as string, digest: options.digest as string, reason: options.reason as string | undefined }
            })()
        return print(options, await send(run.api.v1.platform.upgrade.post({ overrides: { [component]: override }, station: options.station as string | undefined, plan: Boolean(options.plan) })))
      })
    )
}

type UpgradeView = {
  id: string | null
  status: string
  upgrade?: string | null
  release: { from: string; to: string; manifest_digest: string; removed_overrides: string[] } | string
  changes: { order?: number; component: string; station?: string | null; from: { version: string; digest: string | null } | null; to: { version: string; digest: string | null } | null; procedure?: string }[]
  verification: { station_id: string; release?: { signature: string; identity: string | null } | null; items: { component: string; signature: string; duration_ms: number }[] }[] | null
}

const renderUpgrade = (data: unknown) => {
  const u = data as UpgradeView
  if (typeof u.release === 'string') return JSON.stringify(data, null, 2)
  const lines = [`${u.status === 'plan' ? 'plan' : u.status}: release ${u.release.from} -> ${u.release.to} (manifest ${short(u.release.manifest_digest)})${u.upgrade ? `, upgrade ${u.upgrade}` : ''}`]
  if (u.release.removed_overrides.length) lines.push(`overrides removed: ${u.release.removed_overrides.join(', ')}`)
  for (const c of u.changes) lines.push(`${String(c.order ?? '').padStart(2)}. ${c.component.padEnd(18)} ${`${c.from?.version ?? '-'} ${short(c.from?.digest ?? null)}`.padEnd(30)} -> ${`${c.to?.version ?? '-'} ${short(c.to?.digest ?? null)}`.padEnd(30)} ${c.procedure ?? ''}`)
  for (const v of u.verification ?? []) {
    lines.push(`verified on ${v.station_id}: release-manifest.json ${v.release?.signature ?? '-'}${v.release?.identity ? ` (${v.release.identity})` : ''}`)
    for (const i of v.items) lines.push(`  ${i.component.padEnd(18)} ${i.signature} ${i.duration_ms} ms`)
  }
  return lines.join('\n')
}

const waitUpgrade = async (globals: Record<string, unknown>, read: () => Promise<{ data: unknown }>, id: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const inv = (await acrossOutage(read, deadline)).data as { upgrade: { id: string; status: string; steps: { component: string; status: string }[]; failure: { explanation: string } | null } | null }
    const u = inv.upgrade
    if (u && u.id === id) {
      const line = `${u.status}: ${u.steps.map(s => `${s.component}=${s.status}`).join(' ')}`
      if (line !== last) process.stderr.write(`${new Date().toISOString()} ${line}\n`)
      last = line
      if (u.status === 'done') return exitCodes.ok
      if (u.status === 'reverted' || u.status === 'failed') {
        process.stderr.write(`upgrade ${u.status}: ${u.failure?.explanation ?? ''}\n`)
        if (globals.json) process.stdout.write(`${JSON.stringify(u, null, 2)}\n`)
        return exitCodes.api
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  process.stderr.write(`upgrade ${id} did not finish within ${timeoutMs / 1000} s\n`)
  return exitCodes.api
}

type DoctorView = { status: string; checked_at: string; checks: { name: string; station: string | null; status: string; code: string | null; finding: string; fix: string | null }[] }

const renderDoctor = (data: unknown) => {
  const d = data as DoctorView
  const lines = [`doctor ${d.status} at ${d.checked_at}`]
  for (const c of d.checks) {
    lines.push(`${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(22)} ${(c.station ?? 'instance').padEnd(16)} ${c.code ? `[${c.code}] ` : ''}${c.finding}`)
    if (c.fix && c.status !== 'ok') lines.push(`${''.padEnd(46)}fix: ${c.fix}`)
  }
  return lines.join('\n')
}

type InventoryView = {
  release: { version: string; manifest_digest: string } | null
  items: { name: string; station_id: string | null; version: string; digest: string | null; signature: string; status: string; drift: boolean; lockfile_version: string }[]
  base_images: { ref: string; checks: { service: string; digest: string; check: string; latest_digest: string | null }[] }[]
  base_image_checks: { interval_s: number; enabled: boolean }
}

const short = (digest: string | null) => (digest ? digest.slice(0, 19) : '-')

const renderInventory = (data: unknown) => {
  const inv = data as InventoryView
  const lines = [`release ${inv.release ? `${inv.release.version} (${short(inv.release.manifest_digest)})` : 'none'}`, '', 'components']
  for (const c of inv.items) lines.push(`  ${(c.station_id ?? 'instance').padEnd(30)} ${c.name.padEnd(18)} ${c.version.padEnd(14)} ${short(c.digest).padEnd(20)} ${c.signature.padEnd(16)} ${c.status}${c.drift ? ` drift (lockfile ${c.lockfile_version})` : ''}`)
  lines.push('', `base images (checks ${inv.base_image_checks.enabled ? `every ${inv.base_image_checks.interval_s}s` : 'disabled'})`)
  for (const b of inv.base_images) for (const c of b.checks) lines.push(`  ${b.ref.padEnd(40)} ${c.service.padEnd(16)} ${short(c.digest).padEnd(20)} ${c.check}${c.check === 'moved' ? ` -> ${short(c.latest_digest)} (sly services rebuild --service ${c.service})` : ''}`)
  return lines.join('\n')
}
