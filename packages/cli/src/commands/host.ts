import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

import { Option } from '@commander-js/extra-typings'

import {
  adviseMachineRuntime,
  machineRuntimeChoice,
  machineRuntimeTradeoffs,
  rootSocketPath,
  rootSocketVersion,
  stationdUnit,
  type MachineRuntimeAdviceDoc,
  type RootSocketLineDoc,
  type RootSocketOp,
  type RootSocketParams,
  type RootSocketRequestDoc,
  type RootSocketResult,
} from '@stationly/protocol'

import { action, group, type Program } from '../command.ts'
import { env } from '../env.ts'
import { Exit, exitCodes, usage, type EnvelopeCode } from '../errors.ts'
import { bucketName, checkPair, endpointProblem, siblingSuggestion } from '../hostnames.ts'
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
    : 'Run sly setup as root on the server host while stationd runs (or pass --socket).'

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
    'reached through Cloudflare Tunnel; this server opens no web port',
    `hostnames ${r.hostnames.api} and ${r.hostnames.dashboard} are ${r.hostnames.status}; they answer once the tunnel connects`,
    r.litestream
      ? `Litestream bucket ${r.litestream.bucket}: ${r.litestream.note}`
      : 'no Litestream bucket: sly platform doctor reports "no off-host backup of Dispatch"',
    'reach the dashboard:',
    ...r.reach.map((line) => `  ${line}`),
    '',
    'next: sly login --instance <api url> from a laptop, after enrolling TOTP on first sign-in',
  ].join('\n')

const tunnelTokenPrompt =
  "Cloudflare Tunnel token (from the tunnel's page in the Cloudflare dashboard)"

const tunnelSteps =
  'In Cloudflare, create a tunnel and copy its token, then add the published route *.<zone> -> http://stationly-gateway; pass the token with --tunnel-token-stdin (the line after the password with --password-stdin).'

const stdinSecrets = async (passwordStdin: boolean, tokenStdin: boolean) => {
  if (!passwordStdin && !tokenStdin) {
    return {}
  }

  const text = await readStdin()

  if (!passwordStdin || !tokenStdin) {
    return passwordStdin
      ? {
          password: text,
        }
      : {
          token: text,
        }
  }

  const [password = '', token = '', ...rest] = text.split(/\r?\n/)

  if (!password || !token.trim() || rest.some((line) => line.trim())) {
    throw usage(
      'With --password-stdin and --tunnel-token-stdin, stdin must hold two lines.',
      'Send the admin password on the first line and the tunnel token on the second.',
    )
  }

  return {
    password,
    token: token.trim(),
  }
}

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
            flag: '--api-host',
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
          fix: 'Pass an API and a dashboard hostname, each one label under the same zone, such as api.example.com and dash.example.com.',
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

type MachineRuntime = NonNullable<RootSocketParams<'setup'>['sandbox_runtime']>

const runtimeLabel = (runtime: keyof typeof machineRuntimeTradeoffs) =>
  machineRuntimeTradeoffs[runtime].label

const tradeoffText = (advice: MachineRuntimeAdviceDoc) =>
  [
    '',
    'Machine runtime',
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

const machineRuntimeFrom = async (
  given: string | undefined,
  tty: boolean,
  probe: RootSocketResult<'host.probe'>,
): Promise<MachineRuntime | undefined> => {
  const offered = probe.runtimes

  if (given !== undefined) {
    if (!(offered as string[]).includes(given)) {
      throw usage(
        `This host does not offer the machine runtime ${given}.`,
        offered.length
          ? `Pass --machine-runtime with one of ${offered.join(', ')}.`
          : 'Leave out --machine-runtime; this host runs no machines.',
      )
    }

    return given as MachineRuntime
  }

  const advice = adviseMachineRuntime(probe.host, offered)

  if (!advice) {
    return undefined
  }

  if (advice.options.length <= 1) {
    process.stderr.write(`${advice.reasons[0]}\n`)

    return undefined
  }

  process.stderr.write(tradeoffText(advice))

  if (!tty || !machineRuntimeChoice(advice)) {
    return undefined
  }

  return choose(
    'Machine runtime',
    advice.options
      .filter((option) => option.installed)
      .map((option) => ({
        value: option.runtime as MachineRuntime,
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
      "First-admin bootstrap on the server host, as root, through stationd's root socket",
    )
    .option('--socket <path>', 'stationd root socket', rootSocketPath)
    .option('--email <email>', 'admin email')
    .option('--password-stdin', 'read the admin password from stdin')
    .option('--api-host <host>', 'API hostname (hostnames.api), one label under the tunnel zone')
    .option(
      '--dashboard-host <host>',
      'dashboard hostname (hostnames.dashboard), one label under the tunnel zone',
    )
    .option(
      '--tunnel-token-stdin',
      'read the Cloudflare Tunnel token from stdin (after the password line with --password-stdin); the server is reached through the tunnel and opens no web port',
    )
    .option(
      '--machine-runtime <runtime>',
      'the runtime machines on this server use by default; asked only when the host offers more than one',
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

        if (!tty && !options.tunnelTokenStdin) {
          throw usage('sly setup needs the Cloudflare Tunnel token.', tunnelSteps)
        }

        const prompted =
          tty &&
          !(
            options.email &&
            options.passwordStdin &&
            options.tunnelTokenStdin &&
            options.apiHost &&
            options.dashboardHost
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

        const piped = await stdinSecrets(
          Boolean(options.passwordStdin),
          Boolean(options.tunnelTokenStdin),
        )
        let password: string

        if (piped.password !== undefined) {
          password = piped.password
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

        const tunnelToken = (
          piped.token ??
          (await askSecret(tunnelTokenPrompt, (v) =>
            v.trim() ? null : 'a tunnel token is required',
          ))
        ).trim()

        if (!tunnelToken) {
          throw usage('The tunnel token is empty.', tunnelSteps)
        }

        const pair = await hostnamePair(options.apiHost, options.dashboardHost, tty)
        const litestream = await litestreamFrom(options, tty)
        const probe = await rootSocketCall(options.socket, 'host.probe', {}, () => {})
        const machineRuntime = await machineRuntimeFrom(options.machineRuntime, tty, probe)
        const runtimeShown =
          machineRuntime ?? adviseMachineRuntime(probe.host, probe.runtimes)?.default

        if (prompted) {
          process.stderr.write(
            [
              '',
              `  admin          ${email}`,
              `  API host       ${pair.api}`,
              `  dashboard host ${pair.dashboard} (passkey RP ID ${pair.parent})`,
              `  ingress        Cloudflare Tunnel (zone ${pair.parent})`,
              `  Litestream     ${litestream ? `${litestream.bucket}${litestream.endpoint ? ` at ${litestream.endpoint}` : ''}` : 'none'}`,
              `  machines       ${runtimeShown ? runtimeLabel(runtimeShown) : 'none on this host'}`,
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
          hostnames: {
            api: pair.api,
            dashboard: pair.dashboard,
          },
          tunnel_token: tunnelToken,
          ...(machineRuntime
            ? {
                sandbox_runtime: machineRuntime,
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
      "Host-only administration, as root on the server host through stationd's root socket",
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

  group(program, 'platform')
    .command('tunnel-token')
    .description(
      "Replace this server's Cloudflare Tunnel token and restart cloudflared, as root on the server host through stationd's root socket",
    )
    .option('--socket <path>', 'stationd root socket', rootSocketPath)
    .option('--stdin', 'read the token from stdin')
    .action(
      action(async (options) => {
        const token = (
          options.stdin
            ? await readStdin()
            : await need(undefined, {
                what: tunnelTokenPrompt,
                flag: '--stdin',
                secret: true,
              })
        ).trim()

        if (!token) {
          throw usage('The tunnel token is empty.', 'Send the token from Cloudflare on stdin.')
        }

        const result = await rootSocketCall(
          options.socket,
          'tunnel.set_token',
          {
            token,
          },
          () => {},
        )

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : result.restarted
              ? 'tunnel token replaced; cloudflared restarted with it\n'
              : 'tunnel token stored; cloudflared starts with it once the Gateway runs\n',
        )

        return exitCodes.ok
      }),
    )
}
