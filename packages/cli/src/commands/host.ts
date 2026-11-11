import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

import { Option } from '@commander-js/extra-typings'

import {
  adviseSandboxRuntime,
  dispatchAddress,
  rootSocketPath,
  rootSocketVersion,
  sandboxRuntimeChoice,
  sandboxRuntimeTradeoffs,
  stationdUnit,
  type RootSocketLineDoc,
  type RootSocketOp,
  type RootSocketParams,
  type RootSocketRequestDoc,
  type RootSocketResult,
  type SandboxRuntimeAdviceDoc,
} from '@stationly/protocol'

import { action, type Program } from '../command.ts'
import { env } from '../env.ts'
import { Exit, exitCodes, usage, type EnvelopeCode } from '../errors.ts'
import {
  bucketName,
  checkPair,
  endpointProblem,
  ipv4Problem,
  siblingSuggestion,
} from '../hostnames.ts'
import { ask, askSecret, choose, confirm, interactive, need, readStdin } from '../prompt.ts'

const stationdRefusal = () =>
  new Promise<string | null>((resolve) =>
    execFile(
      'journalctl',
      ['-u', stationdUnit, '-n', '50', '--no-pager', '-o', 'cat'],
      {
        timeout: 3000,
      },
      (error, stdout) => {
        if (error) {
          return resolve(null)
        }

        resolve(
          stdout
            .split('\n')
            .filter((line) => line.includes('Dispatch refused'))
            .pop() ?? null,
        )
      },
    ),
  )

const unreachable = async (path: string, reason: string) => {
  const refusal = await stationdRefusal()
  const explanation = refusal
    ? `stationd never opened its root socket at ${path} because it cannot enroll with Dispatch: ${refusal}`
    : `cannot reach stationd's root socket at ${path}: ${reason}`
  const fix = refusal
    ? `Fix the cause above and restart it: systemctl restart ${stationdUnit}; journalctl -u ${stationdUnit} has the full log.`
    : 'Run sly setup as root on the station host while stationd runs (or pass --socket).'

  return new Exit(exitCodes.connection, {
    error: {
      code: 'CONNECTION_FAILED',
      explanation,
      fix,
    },
  })
}

export const rootSocketCall = <Op extends RootSocketOp>(
  path: string,
  op: Op,
  params: RootSocketParams<Op>,
  onProgress: (step: string, detail: string) => void,
) =>
  new Promise<RootSocketResult<Op>>((resolve, reject) => {
    const id = `r${Date.now()}`
    const socket = createConnection(path)

    socket.once('error', (error) => void unreachable(path, error.message).then(reject))
    const request: RootSocketRequestDoc = {
      v: rootSocketVersion,
      id,
      op,
      params,
    }

    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    const lines = createInterface({
      input: socket,
    })

    lines.on('error', () => {})
    lines.on('line', (text) => {
      const line = JSON.parse(text) as RootSocketLineDoc

      if (line.id !== id) {
        return
      }

      if (line.progress) {
        return onProgress(line.progress.step, line.progress.detail ?? '')
      }

      if (line.ok === undefined) {
        return
      }

      socket.end()

      if (line.ok) {
        resolve(line.result as RootSocketResult<Op>)
      } else {
        reject(
          new Exit(exitCodes.api, {
            error: {
              code: (line.error?.code as EnvelopeCode | undefined) ?? 'INTERNAL_ERROR',
              explanation: line.error?.explanation ?? 'stationd refused the operation',
              fix: line.error?.fix,
            },
          }),
        )
      }
    })
    lines.once('close', () =>
      reject(
        new Exit(exitCodes.connection, {
          error: {
            code: 'CONNECTION_FAILED',
            explanation: 'stationd closed the root socket before answering',
            fix: 'Check the stationd log.',
          },
        }),
      ),
    )
  })

type Litestream = NonNullable<RootSocketParams<'setup'>['litestream']>

const minPassword = 12

const render = (r: RootSocketResult<'setup'>) =>
  [
    `admin ${r.email} created (${r.admin_user_id}) in instance ${r.instance_id}`,
    r.lockfile
      ? `lockfile pins release ${r.lockfile.release} (${r.lockfile.manifest_digest?.slice(0, 19)})`
      : 'no lockfile written',
    '',
    `recovery key (shown once; store it offline now): ${r.recovery_key ?? 'unavailable'}`,
    '',
    `one-time login link, valid until ${r.login_link_expires_at}:`,
    `  ${r.login_link ?? 'none'}`,
    '',
    r.public_address
      ? `station public address ${r.public_address}`
      : 'no public address set: sly stations update <station> --public-address <ipv4> before the Gateway routes go out',
    r.hostnames
      ? `hostnames ${r.hostnames.api} and ${r.hostnames.dashboard} are ${r.hostnames.status}; the Gateway issues certificates once DNS points at this host`
      : 'no domain: Dispatch stays on the loopback publish',
    r.litestream
      ? `Litestream bucket ${r.litestream.bucket}: ${r.litestream.note}`
      : 'no Litestream bucket: sly platform doctor reports "no off-host backup of Dispatch"',
    'reach the dashboard:',
    ...r.reach.map((line) => `  ${line}`),
    '',
    'next: sly login --instance <api url> from a laptop, after enrolling TOTP on first sign-in',
  ].join('\n')

const cancelled = () => usage('Setup was cancelled; nothing was created.', 'Run sly setup again.')

const emailProblem = (value: string) =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : 'that is not an email address'

const askPassword = async () => {
  const password = await askSecret(`admin password (${minPassword} characters or more)`, (v) =>
    v.length < minPassword ? `the password needs at least ${minPassword} characters` : null,
  )

  await askSecret('repeat the password', (v) =>
    v === password ? null : 'the two passwords differ',
  )

  return password
}

const hostnamePair = async (
  api: string | undefined,
  dashboard: string | undefined,
  tty: boolean,
) => {
  for (;;) {
    const a = (
      api ??
      (tty
        ? await ask('API hostname (for example api.example.com)', {
            valid: (v) => (v ? null : 'an API hostname is required'),
          })
        : await need(undefined, {
            what: 'API hostname',
            flag: '--api-host, or --no-domain',
          }))
    ).toLowerCase()
    const d = (
      dashboard ??
      (tty
        ? await ask('dashboard hostname', {
            valid: (v) => (v ? null : 'a dashboard hostname is required'),
            fallback: siblingSuggestion(a, 'dash'),
          })
        : await need(undefined, {
            what: 'dashboard hostname',
            flag: '--dashboard-host',
          }))
    ).toLowerCase()
    const check = checkPair(a, d)

    if (check.ok) {
      return {
        api: a,
        dashboard: d,
        parent: check.parent,
      }
    }

    if (!tty || (api && dashboard)) {
      throw new Exit(exitCodes.api, {
        error: {
          code: 'HOSTNAME_DOMAIN_MISMATCH',
          explanation: `${check.reason}.`,
          fix: 'Pass an API and a dashboard hostname under one registrable domain, or --no-domain.',
        },
      })
    }

    process.stderr.write(`  ${check.reason}\n`)
    api = undefined
    dashboard = undefined
  }
}

const litestreamFrom = async (
  options: { litestreamBucket?: string; litestreamEndpoint?: string; litestreamAccessKey?: string },
  tty: boolean,
): Promise<Litestream | null> => {
  const bucket =
    options.litestreamBucket ??
    (tty
      ? await ask('Litestream bucket for an off-host copy of Dispatch (optional, Enter to skip)', {
          valid: (v) =>
            !v || bucketName.test(v)
              ? null
              : 'a bucket name is 3 to 63 lowercase letters, digits, dots or dashes',
        })
      : '')

  if (!bucket) {
    return null
  }

  if (!bucketName.test(bucket)) {
    throw usage(
      `${bucket} is not a bucket name.`,
      'Pass a bucket name of 3 to 63 lowercase letters, digits, dots or dashes.',
    )
  }

  const endpoint =
    options.litestreamEndpoint ??
    (tty
      ? await ask(
          'S3 endpoint URL (Enter for AWS S3; R2 is https://<account>.r2.cloudflarestorage.com)',
          {
            valid: endpointProblem,
          },
        )
      : '')
  const bad = endpointProblem(endpoint)

  if (bad) {
    throw usage(
      `${endpoint} is not a usable endpoint: ${bad}.`,
      'Pass --litestream-endpoint https://... (or http:// on a private address).',
    )
  }

  const access_key =
    options.litestreamAccessKey ??
    (await need(undefined, {
      what: 'bucket access key id',
      flag: '--litestream-access-key or LITESTREAM_ACCESS_KEY_ID',
    }))
  const secret_key =
    env.LITESTREAM_SECRET_ACCESS_KEY ??
    (await need(undefined, {
      what: 'bucket secret access key',
      flag: 'LITESTREAM_SECRET_ACCESS_KEY',
      secret: true,
    }))

  return {
    bucket,
    endpoint,
    access_key,
    secret_key,
  }
}

const publicAddressFrom = async (
  options: { publicAddress?: string; detectPublicAddress?: true },
  tty: boolean,
  detect: () => Promise<RootSocketResult<'public_address.detect'>>,
) => {
  const given = options.publicAddress

  if (given) {
    const problem = ipv4Problem(given)

    if (problem) {
      throw usage(
        `${given}: ${problem}.`,
        "Pass --public-address with the host's public IPv4 address.",
      )
    }

    return given
  }

  if (options.detectPublicAddress) {
    const found = await detect()

    if (!found.address || !found.public) {
      throw usage(
        found.address
          ? `${found.interface} has ${found.address}, which is not a public address.`
          : `no address detected: ${found.reason ?? 'unknown reason'}.`,
        'Pass --public-address with the address the internet reaches this host on.',
      )
    }

    return found.address
  }

  if (!tty) {
    return undefined
  }

  const found = await detect()

  if (found.address && found.public) {
    process.stderr.write(
      `  the default-route interface ${found.interface} has the public address ${found.address}\n`,
    )
  } else {
    process.stderr.write(
      `  ${found.address ? `the default-route interface ${found.interface} has ${found.address}, which is not a public address (private, CGNAT or reserved)` : `no address detected (${found.reason ?? 'no reason given'})`}\n`,
    )
  }

  const entered = await ask(
    found.address && found.public
      ? 'station public IPv4 address (Enter to accept, or type another)'
      : 'station public IPv4 address (Enter to skip)',
    {
      valid: (v) => (!v ? null : ipv4Problem(v)),
      fallback: found.address && found.public ? found.address : '',
    },
  )

  return entered || undefined
}

type SandboxRuntime = NonNullable<RootSocketParams<'setup'>['sandbox_runtime']>

const runtimeLabel = (runtime: keyof typeof sandboxRuntimeTradeoffs) =>
  sandboxRuntimeTradeoffs[runtime].label

const tradeoffText = (advice: SandboxRuntimeAdviceDoc) =>
  [
    '',
    'Sandbox runtime',
    ...advice.reasons.map((reason) => `  ${reason}`),
    ...advice.options.flatMap((option) => [
      '',
      `  ${[
        runtimeLabel(option.runtime),
        option.recommended ? 'recommended for this host' : null,
        option.installed ? null : 'not installed in this release',
      ]
        .filter((part) => part !== null)
        .join(', ')}`,
      ...option.pros.map((pro) => `    + ${pro}`),
      ...option.cons.map((con) => `    - ${con}`),
    ]),
    '',
  ].join('\n') + '\n'

const sandboxRuntimeFrom = async (
  given: string | undefined,
  tty: boolean,
  probe: RootSocketResult<'host.probe'>,
): Promise<SandboxRuntime | undefined> => {
  const offered = probe.runtimes

  if (given !== undefined) {
    if (!(offered as string[]).includes(given)) {
      throw usage(
        `This host does not offer the sandbox runtime ${given}.`,
        offered.length
          ? `Pass --sandbox-runtime with one of ${offered.join(', ')}.`
          : 'Leave out --sandbox-runtime; this host runs no sandboxes.',
      )
    }

    return given as SandboxRuntime
  }

  const advice = adviseSandboxRuntime(probe.host, offered)

  if (!advice) {
    return undefined
  }

  if (advice.options.length <= 1) {
    process.stderr.write(`${advice.reasons[0]}\n`)

    return undefined
  }

  process.stderr.write(tradeoffText(advice))

  if (!tty || !sandboxRuntimeChoice(advice)) {
    return undefined
  }

  return choose(
    'Sandbox runtime',
    advice.options
      .filter((option) => option.installed)
      .map((option) => ({
        value: option.runtime as SandboxRuntime,
        label: runtimeLabel(option.runtime),
        hint: option.recommended ? 'recommended' : undefined,
      })),
    advice.default,
  )
}

export const hostCommands = (program: Program) => {
  program
    .command('setup')
    .description(
      "First-admin bootstrap on the station host, as root, through stationd's root socket",
    )
    .option('--socket <path>', 'stationd root socket', rootSocketPath)
    .option('--email <email>', 'admin email')
    .option('--password-stdin', 'read the admin password from stdin')
    .option('--acme-email <email>', 'ACME account email (acme.email)')
    .option('--api-host <host>', 'API hostname (hostnames.api)')
    .option('--dashboard-host <host>', 'dashboard hostname (hostnames.dashboard)')
    .option('--no-domain', 'skip the hostnames; Dispatch stays on the loopback publish')
    .option('--public-address <ipv4>', "the station's public IPv4 address (station.public_address)")
    .addOption(
      new Option(
        '--detect-public-address',
        'use the IPv4 address of the default-route interface when it is public; no lookup service is contacted',
      ).conflicts('publicAddress'),
    )
    .option(
      '--sandbox-runtime <runtime>',
      'the runtime sandboxes on this station use by default; asked only when the host offers more than one',
    )
    .option(
      '--litestream-bucket <bucket>',
      'bucket for an off-host copy of Dispatch, replicated by the Litestream sidecar',
    )
    .option(
      '--litestream-endpoint <url>',
      'S3-compatible endpoint of the bucket: https, or http on a private address (default AWS S3)',
    )
    .addOption(
      new Option(
        '--litestream-access-key <id>',
        'bucket access key id; the secret comes from LITESTREAM_SECRET_ACCESS_KEY',
      ).env('LITESTREAM_ACCESS_KEY_ID'),
    )
    .action(
      action(async (options) => {
        const tty = interactive()
        const prompted =
          tty &&
          !(
            options.email &&
            options.passwordStdin &&
            (!options.domain || (options.apiHost && options.dashboardHost)) &&
            (options.publicAddress || options.detectPublicAddress)
          )

        if (prompted) {
          process.stderr.write(
            'Stationly setup: this creates the single admin and puts Dispatch on its hostnames. Ctrl-C cancels; nothing is created before the last question.\n\n',
          )
        }

        const email = (
          options.email ??
          (tty
            ? await ask('admin email', {
                valid: emailProblem,
              })
            : await need(undefined, {
                what: 'admin email',
                flag: '--email',
              }))
        ).trim()

        if (emailProblem(email)) {
          throw usage(`${email} is not an email address.`, 'Pass --email with the admin address.')
        }

        let password: string

        if (options.passwordStdin) {
          password = await readStdin()
        } else if (tty) {
          password = await askPassword()
        } else {
          password = await need(undefined, {
            what: 'admin password',
            flag: '--password-stdin',
            secret: true,
          })
        }

        if (password.length < minPassword) {
          throw usage(
            `The password needs at least ${minPassword} characters.`,
            'Choose a longer password.',
          )
        }

        const domain = !options.domain
          ? false
          : options.apiHost || options.dashboardHost || !tty
            ? true
            : await confirm(
                'Serve the dashboard and API on hostnames of your own domain? (No: domainless, reached through an SSH forward)',
              )
        const pair = domain ? await hostnamePair(options.apiHost, options.dashboardHost, tty) : null
        const acme =
          options.acmeEmail ??
          (tty
            ? await ask(
                pair
                  ? "ACME email for Let's Encrypt"
                  : "ACME email for Let's Encrypt (optional, Enter to skip)",
                {
                  valid: (v) =>
                    (!v && !pair) || !emailProblem(v) ? null : 'that is not an email address',
                  fallback: pair ? email : '',
                },
              )
            : pair
              ? await need(undefined, {
                  what: "ACME email for Let's Encrypt",
                  flag: '--acme-email',
                })
              : undefined)
        const detect = () => rootSocketCall(options.socket, 'public_address.detect', {}, () => {})
        const publicAddress = await publicAddressFrom(options, tty, detect)
        const litestream = await litestreamFrom(options, tty)
        const probe = await rootSocketCall(options.socket, 'host.probe', {}, () => {})
        const sandboxRuntime = await sandboxRuntimeFrom(options.sandboxRuntime, tty, probe)
        const runtimeShown =
          sandboxRuntime ?? adviseSandboxRuntime(probe.host, probe.runtimes)?.default

        if (prompted) {
          process.stderr.write(
            [
              '',
              `  admin          ${email}`,
              pair
                ? `  API host       ${pair.api}`
                : `  hostnames      none (domainless; SSH forward to ${dispatchAddress})`,
              pair ? `  dashboard host ${pair.dashboard} (passkey RP ID ${pair.parent})` : null,
              `  ACME email     ${acme || 'none'}`,
              `  public address ${publicAddress ?? 'none (set it later with sly stations update)'}`,
              `  Litestream     ${litestream ? `${litestream.bucket}${litestream.endpoint ? ` at ${litestream.endpoint}` : ''}` : 'none'}`,
              `  sandboxes      ${runtimeShown ? runtimeLabel(runtimeShown) : 'none on this host'}`,
              '',
            ]
              .filter((line) => line !== null)
              .join('\n') + '\n',
          )

          if (!(await confirm('Create the admin and apply these settings?'))) {
            throw cancelled()
          }
        }

        const params: RootSocketParams<'setup'> = {
          email,
          password,
          ...(acme
            ? {
                acme_email: acme,
              }
            : {}),
          ...(pair
            ? {
                hostnames: {
                  api: pair.api,
                  dashboard: pair.dashboard,
                },
              }
            : {}),
          ...(publicAddress
            ? {
                public_address: publicAddress,
              }
            : {}),
          ...(sandboxRuntime
            ? {
                sandbox_runtime: sandboxRuntime,
              }
            : {}),
          ...(litestream
            ? {
                litestream,
              }
            : {}),
        }
        const result = await rootSocketCall(options.socket, 'setup', params, (step, detail) => {
          if (!options.json) {
            process.stderr.write(`${step}: ${detail}\n`)
          }
        })

        process.stdout.write(
          options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`,
        )

        if (!options.json && interactive()) {
          const stored = await need(undefined, {
            what: 'type "stored" once the recovery key is saved',
            flag: '--json',
          })

          if (stored !== 'stored') {
            process.stderr.write(
              'store the recovery key before closing this terminal; without it a restore marks every secret needs_reentry\n',
            )
          }
        }

        return exitCodes.ok
      }),
    )
}

export const adminHostCommands = (program: Program) => {
  const admin = program
    .command('admin')
    .description(
      "Host-only administration, as root on the station host through stationd's root socket",
    )

  admin
    .command('recovery-key')
    .description('Print the recovery key again; the display is audited')
    .option('--socket <path>', 'stationd root socket', rootSocketPath)
    .action(
      action(async (options) => {
        const { recovery_key } = await rootSocketCall(
          options.socket,
          'admin.recovery_key',
          {},
          () => {},
        )

        process.stdout.write(
          options.json
            ? `${JSON.stringify(
                {
                  recovery_key,
                },
                null,
                2,
              )}\n`
            : `${recovery_key}\n`,
        )

        if (!options.json) {
          process.stderr.write(
            'this display was recorded in the audit log; store the key offline\n',
          )
        }

        return exitCodes.ok
      }),
    )
}
