import { action, group, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { connect, send, type Api, type Data, type Globals, type Run } from '../kit.ts'
import { pollUntil } from '../outage.ts'
import { json, print } from '../output.ts'
import { renderUpgrade } from '../renderers/platform.ts'

export const platformCommands = (program: Program) => {
  const platform = group(program, 'platform')
  platform
    .command('upgrade')
    .description(
      'Upgrade to a signed release with --version, or override one component by digest or reset its override; --plan prints the diff without staging, --wait follows the upgrade in the inventory',
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
