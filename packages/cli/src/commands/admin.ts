import { actorTypeValues } from '@stationly/protocol'

import { action, call, collect, integer, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import {
  connect,
  environmentId,
  isLevel,
  isOneOf,
  send,
  type Api,
  type Data,
  type Globals,
  type Run,
} from '../kit.ts'
import { pollUntil } from '../outage.ts'
import { json, print } from '../output.ts'
import { renderDoctor, renderInventory, renderUpgrade } from '../renderers/platform.ts'

export const parseScope = (spec: string) => {
  const [project_id, environment_id, level] = spec.split(':')
  if (!project_id || !environment_id || !level || !isLevel(level))
    throw usage(
      `${spec} is not a scope.`,
      'Write project:environment:level with ids or *, such as prj_1:*:deploy.',
    )
  return {
    project_id,
    environment_id,
    level,
  }
}

export const adminCommands = (program: Program) => {
  const staged = program.command('staged').description('Staged changes')
  staged
    .command('list')
    .option('--status <status>', 'staged (default), accepted, rejected or superseded')
    .option('--platform', 'instance-scoped (platform) changes rather than the selected environment')
    .action(
      call(async (run, options) => {
        const query = {
          status: options.status,
        }
        if (options.platform || (!run.selection.project && !run.selection.environment))
          return run.api.v1['staged-changes'].get({
            query: {
              ...query,
              scope: 'instance',
            },
          })
        return run.api.v1
          .environments({
            environment: await environmentId(run),
          })
          ['staged-changes'].get({
            query,
          })
      }),
    )
  staged
    .command('accept')
    .argument('<staged-change>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1['staged-changes']({
          id,
        }).accept.post(),
      ),
    )
  staged
    .command('reject')
    .argument('<staged-change>')
    .option('--reason <reason>')
    .action(
      call(async (run, options, id) =>
        run.api.v1['staged-changes']({
          id,
        }).reject.post({
          reason: options.reason,
        }),
      ),
    )

  const stations = program.command('stations').description('Stations')
  stations
    .command('list')
    .option('--status <status>')
    .action(
      call(async (run, options) =>
        run.api.v1.stations.get({
          query: {
            status: options.status,
          },
        }),
      ),
    )
  stations
    .command('describe')
    .argument('<station>')
    .action(
      call(async (run, _options, station) =>
        run.api.v1
          .stations({
            station,
          })
          .get({
            query: {
              fields: '*',
            },
          }),
      ),
    )
  stations
    .command('add')
    .argument('<name>')
    .option('--intermittent', 'the station sleeps and wakes')
    .action(
      action(async (options, name) => {
        const run = await connect(options)
        const sent = await send(
          run.api.v1.stations.post({
            name,
            intermittent: options.intermittent,
          }),
        )
        if (!options.json)
          process.stderr.write(`run on the new host within 15 minutes:\n  ${sent.data.command}\n`)
        return print(options, sent)
      }),
    )
  stations
    .command('update')
    .argument('<station>')
    .option(
      '--public-address <ipv4>',
      'the IPv4 address inbound 80, 443 and port allocations answer on',
    )
    .option('--concurrency-cap <n>', 'deployments the station runs at once', integer)
    .option('--draining', 'place no new deployments on the station')
    .option('--no-draining', 'end the drain')
    .option('--intermittent', 'the station is expected to go away, as a gaming PC does')
    .option('--no-intermittent', 'the station is expected to stay online')
    .action(
      call(async (run, options, station) =>
        run.api.v1
          .stations({
            station,
          })
          .patch({
            public_address: options.publicAddress,
            concurrency_cap: options.concurrencyCap,
            draining: options.draining,
            intermittent: options.intermittent,
          }),
      ),
    )

  const tokens = program.command('tokens').description('Tokens')
  tokens
    .command('list')
    .option('--kind <kind>')
    .action(
      call(async (run, options) =>
        run.api.v1.tokens.get({
          query: {
            kind: options.kind,
          },
        }),
      ),
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
        const scopes = options.scope?.map(parseScope)
        if (!options.personal && !scopes)
          throw usage(
            'A scoped token needs at least one scope.',
            'Pass --scope project:environment:level.',
          )
        const sent = await send(
          run.api.v1.tokens.post({
            name,
            kind: options.personal ? 'personal' : 'scoped',
            scopes,
            expires_in_s: options.ttl,
          }),
        )
        if (!options.json) process.stderr.write('the key is shown once; store it now\n')
        return print(options, sent)
      }),
    )
  tokens
    .command('revoke')
    .argument('<token>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .tokens({
            id,
          })
          .delete(),
      ),
    )
  tokens
    .command('renew')
    .argument('<token>')
    .option('--ttl <duration>', 'new lifetime from now, at most 1 year', seconds)
    .action(
      call(async (run, options, id) =>
        run.api.v1
          .tokens({
            id,
          })
          .renew.post({
            expires_in_s: options.ttl,
          }),
      ),
    )

  const settings = program.command('settings').description('Instance settings')
  settings
    .command('get')
    .argument('[key]', 'a key or a prefix such as ipam.')
    .action(
      call(async (run, _options, key) =>
        run.api.v1.settings.get({
          query: {
            prefix: key,
          },
        }),
      ),
    )
  settings
    .command('set')
    .argument('<key>')
    .argument('<value>', 'JSON value, or a plain string')
    .option(
      '--reset-passkeys',
      'allow a hostname change that needs a new passkey RP ID (human actor only)',
    )
    .action(
      call(async (run, options, key, value) => {
        const parsed = (() => {
          try {
            return JSON.parse(value) as unknown
          } catch {
            return value
          }
        })()
        return run.api.v1.settings.patch(
          {
            [key]: parsed,
          },
          {
            query: {
              reset_passkeys: options.resetPasskeys,
            },
          },
        )
      }),
    )

  program
    .command('audit')
    .description('Audit trail, newest first')
    .option('--since <time>', 'RFC 3339 or relative such as 10m or -1h')
    .option('--until <time>')
    .option(
      '--actor <actor>',
      'actor type (user, token, oauth_client, station, system) or actor id',
    )
    .option('--action <prefix>', 'action prefix such as secret.')
    .option('--limit <n>', 'page size (max 200)', integer)
    .option('--cursor <cursor>')
    .action(
      call(async (run, options) => {
        const { actor } = options
        const type = actor && isOneOf(actorTypeValues, actor) ? actor : undefined
        return run.api.v1.audit.get({
          query: {
            since: options.since,
            until: options.until,
            actor_type: type,
            actor_id: actor && !type ? actor : undefined,
            action: options.action,
            limit: options.limit,
            cursor: options.cursor,
          },
        })
      }),
    )

  const platform = program
    .command('platform')
    .description('Lockfile, signatures, inventory and releases')
  platform
    .command('inventory')
    .description(
      'Components with versions, digests, signatures and drift; base images with their last check',
    )
    .option('--station <station>')
    .action(
      call(
        async (run, options) =>
          run.api.v1.inventory.get({
            query: {
              station: options.station,
            },
          }),
        renderInventory,
      ),
    )
  platform
    .command('doctor')
    .description('Health report: each check ok, warn or fail with a finding, a code and a fix')
    .option('--station <station>')
    .option('--checks <names>', 'comma-separated check names')
    .action(
      action(async (options) => {
        const run = await connect(options)
        const sent = await send(
          run.api.v1.doctor.get({
            query: {
              station: options.station,
              checks: options.checks,
            },
          }),
        )
        print(options, sent, renderDoctor)
        return sent.data.status === 'fail' ? exitCodes.api : exitCodes.ok
      }),
    )
  platform
    .command('check')
    .description('Releases newer than the pinned one (only while platform.release_check is true)')
    .action(
      action(async (options) => {
        const run = await connect(options)
        const sent = await send(run.api.v1.platform.releases.get())
        if (!options.json && !sent.data.enabled) {
          process.stdout.write('release check disabled\n')
          return 0
        }
        return print(options, sent)
      }),
    )
  platform
    .command('upgrade')
    .description(
      'Override one component by digest, or reset its override; --plan prints the diff without staging',
    )
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
          if (!options.version)
            throw usage(
              'Name a component, or --version for a release.',
              'sly platform upgrade <component> --version <v> --digest <sha256:...>',
            )
          const sent = await send(
            run.api.v1.platform.upgrade.post({
              version: options.version,
              station: options.station,
              plan: Boolean(options.plan),
            }),
          )
          const code = print(options, sent, renderUpgrade)
          const upgradeId = 'upgrade' in sent.data ? sent.data.upgrade : undefined
          if (!options.wait || !upgradeId) return code
          return waitUpgrade(run, options, upgradeId, options.timeout)
        }
        const override = options.reset
          ? {
              reset: true as const,
            }
          : (() => {
              if (!options.version || !options.digest)
                throw usage(
                  'An override needs --version and --digest.',
                  'sly platform upgrade gateway --version 3.7.18 --digest sha256:...',
                )
              return {
                version: options.version,
                digest: options.digest,
                reason: options.reason,
              }
            })()
        return print(
          options,
          await send(
            run.api.v1.platform.upgrade.post({
              overrides: {
                [component]: override,
              },
              station: options.station,
              plan: Boolean(options.plan),
            }),
          ),
        )
      }),
    )
}

const waitUpgrade = async (run: Run, globals: Globals, id: string, timeoutS: number) => {
  const deadline = Date.now() + timeoutS * 1000
  let last = ''
  const current = (inventory: Data<Api['inventory']['get']>) =>
    inventory.upgrade?.id === id ? inventory.upgrade : null
  const finished = ['done', 'reverted', 'failed']
  const inventory = await pollUntil(
    async () =>
      (
        await send(
          run.api.v1.inventory.get({
            query: {},
          }),
        )
      ).data,
    (inv) => {
      const u = current(inv)
      if (!u) return false
      const line = `${u.status}: ${u.steps.map((s) => `${s.component}=${s.status}`).join(' ')}`
      if (line !== last) process.stderr.write(`${new Date().toISOString()} ${line}\n`)
      last = line
      return finished.includes(u.status)
    },
    deadline,
    1000,
  )
  const u = current(inventory)
  if (u?.status === 'done') return exitCodes.ok
  if (u && finished.includes(u.status)) {
    process.stderr.write(`upgrade ${u.status}: ${u.failure?.explanation ?? ''}\n`)
    if (globals.json) json(u)
    return exitCodes.api
  }
  process.stderr.write(`upgrade ${id} did not finish within ${timeoutS} s\n`)
  return exitCodes.api
}
