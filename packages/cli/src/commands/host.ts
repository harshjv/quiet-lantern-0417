import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Command } from 'commander'
import { action } from '../command.ts'
import { Exit, exitCodes, usage } from '../errors.ts'
import { bucketName, checkPair, endpointProblem, ipv4Problem, siblingSuggestion } from '../hostnames.ts'
import { ask, askSecret, confirm, interactive, need, readStdin } from '../prompt.ts'

export const defaultSocket = '/run/stationly/stationd.sock'

type Line = { v: number; id: string; progress?: { step: string; detail?: string }; ok?: boolean; result?: unknown; error?: { code: string; explanation: string; fix?: string; details?: unknown } }

const stationdUnit = 'stationly-stationd'

const stationdRefusal = () =>
  new Promise<string | null>(resolve =>
    execFile('journalctl', ['-u', stationdUnit, '-n', '50', '--no-pager', '-o', 'cat'], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null)
      resolve(stdout.split('\n').filter(line => line.includes('Dispatch refused')).pop() ?? null)
    })
  )

const unreachable = async (path: string, reason: string) => {
  const refusal = await stationdRefusal()
  const explanation = refusal
    ? `stationd never opened its root socket at ${path} because it cannot enroll with Dispatch: ${refusal}`
    : `cannot reach stationd's root socket at ${path}: ${reason}`
  const fix = refusal ? `Fix the cause above and restart it: systemctl restart ${stationdUnit}; journalctl -u ${stationdUnit} has the full log.` : 'Run sly setup as root on the station host while stationd runs (or pass --socket).'
  return new Exit(exitCodes.connection, { error: { code: 'CONNECTION_FAILED', explanation, fix } })
}

export const rootSocketCall = (path: string, op: string, params: Record<string, unknown>, onProgress: (step: string, detail: string) => void) =>
  new Promise<unknown>((resolve, reject) => {
    const id = `r${Date.now()}`
    const socket = createConnection(path)
    socket.once('error', error => void unreachable(path, error.message).then(reject))
    socket.once('connect', () => socket.write(`${JSON.stringify({ v: 1, id, op, params })}\n`))
    const lines = createInterface({ input: socket })
    lines.on('error', () => {})
    lines.on('line', text => {
      const line = JSON.parse(text) as Line
      if (line.id !== id) return
      if (line.progress) return onProgress(line.progress.step, line.progress.detail ?? '')
      if (line.ok === undefined) return
      socket.end()
      if (line.ok) resolve(line.result)
      else reject(new Exit(exitCodes.api, { error: { code: line.error?.code ?? 'INTERNAL_ERROR', explanation: line.error?.explanation ?? 'stationd refused the operation', fix: line.error?.fix } }))
    })
    lines.once('close', () => reject(new Exit(exitCodes.connection, { error: { code: 'CONNECTION_FAILED', explanation: 'stationd closed the root socket before answering', fix: 'Check the stationd log.' } })))
  })

type SetupResult = {
  admin_user_id: string
  email: string
  instance_id: string
  login_link: string | null
  login_link_expires_at: string
  recovery_key?: string
  lockfile: { release: string | null; manifest_digest: string | null } | null
  hostnames: { api: string; dashboard: string; status: string } | null
  public_address?: string | null
  litestream?: { bucket: string; endpoint: string | null; active: boolean; note: string } | null
  reach: string[]
}

type DetectedAddress = { address: string | null; interface: string | null; public: boolean; reason?: string }

type Litestream = { bucket: string; endpoint: string; access_key: string; secret_key: string }

const minPassword = 12

const render = (r: SetupResult) =>
  [
    `admin ${r.email} created (${r.admin_user_id}) in instance ${r.instance_id}`,
    r.lockfile ? `lockfile pins release ${r.lockfile.release} (${r.lockfile.manifest_digest?.slice(0, 19)})` : 'no lockfile written',
    '',
    `recovery key (shown once; store it offline now): ${r.recovery_key ?? 'unavailable'}`,
    '',
    `one-time login link, valid until ${r.login_link_expires_at}:`,
    `  ${r.login_link ?? 'none'}`,
    '',
    r.public_address ? `station public address ${r.public_address}` : 'no public address set: sly stations update <station> --public-address <ipv4> before the Gateway routes go out',
    r.hostnames ? `hostnames ${r.hostnames.api} and ${r.hostnames.dashboard} are ${r.hostnames.status}; the Gateway issues certificates once DNS points at this host` : 'no domain: Dispatch stays on the loopback publish',
    r.litestream ? `Litestream bucket ${r.litestream.bucket}: ${r.litestream.note}` : 'no Litestream bucket: sly platform doctor reports "no off-host backup of Dispatch"',
    'reach the dashboard:',
    ...r.reach.map(line => `  ${line}`),
    '',
    'next: sly login --instance <api url> from a laptop, after enrolling TOTP on first sign-in'
  ].join('\n')

const cancelled = () => usage('Setup was cancelled; nothing was created.', 'Run sly setup again.')

const askUntil = async (question: string, valid: (value: string) => string | null, fallback = '') => {
  for (;;) {
    const value = (await ask(question, fallback)).trim()
    const problem = valid(value)
    if (!problem) return value
    process.stderr.write(`  ${problem}\n`)
  }
}

const emailProblem = (value: string) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : 'that is not an email address')

const askPassword = async () => {
  for (;;) {
    const password = await askSecret(`admin password (${minPassword} characters or more)`)
    if (password.length < minPassword) {
      process.stderr.write(`  the password needs at least ${minPassword} characters\n`)
      continue
    }
    if ((await askSecret('repeat the password')) === password) return password
    process.stderr.write('  the two passwords differ\n')
  }
}

const hostnamePair = async (api: string | undefined, dashboard: string | undefined, tty: boolean) => {
  for (;;) {
    const a = (api ?? (tty ? await askUntil('API hostname (for example api.example.com)', v => (v ? null : 'an API hostname is required')) : await need(undefined, { what: 'API hostname', flag: '--api-host, or --no-domain' }))).toLowerCase()
    const d = (dashboard ?? (tty ? await askUntil('dashboard hostname', v => (v ? null : 'a dashboard hostname is required'), siblingSuggestion(a, 'dash')) : await need(undefined, { what: 'dashboard hostname', flag: '--dashboard-host' }))).toLowerCase()
    const check = checkPair(a, d)
    if (check.ok) return { api: a, dashboard: d, parent: check.parent }
    if (!tty || (api && dashboard)) throw new Exit(exitCodes.api, { error: { code: 'HOSTNAME_DOMAIN_MISMATCH', explanation: `${check.reason}.`, fix: 'Pass an API and a dashboard hostname under one registrable domain, or --no-domain.' } })
    process.stderr.write(`  ${check.reason}\n`)
    api = undefined
    dashboard = undefined
  }
}

const litestreamFrom = async (options: Record<string, unknown>, tty: boolean): Promise<Litestream | null> => {
  const bucket = (options.litestreamBucket as string | undefined) ?? (tty ? await askUntil('Litestream bucket for an off-host copy of Dispatch (optional, Enter to skip)', v => (!v || bucketName.test(v) ? null : 'a bucket name is 3 to 63 lowercase letters, digits, dots or dashes')) : '')
  if (!bucket) return null
  if (!bucketName.test(bucket)) throw usage(`${bucket} is not a bucket name.`, 'Pass a bucket name of 3 to 63 lowercase letters, digits, dots or dashes.')
  const endpoint = (options.litestreamEndpoint as string | undefined) ?? (tty ? await askUntil('S3 endpoint URL (Enter for AWS S3; R2 is https://<account>.r2.cloudflarestorage.com)', endpointProblem) : '')
  const bad = endpointProblem(endpoint)
  if (bad) throw usage(`${endpoint} is not a usable endpoint: ${bad}.`, 'Pass --litestream-endpoint https://... (or http:// on a private address).')
  const access_key = (options.litestreamAccessKey as string | undefined) ?? process.env.LITESTREAM_ACCESS_KEY_ID ?? (await need(undefined, { what: 'bucket access key id', flag: '--litestream-access-key or LITESTREAM_ACCESS_KEY_ID' }))
  const secret_key = process.env.LITESTREAM_SECRET_ACCESS_KEY ?? (await need(undefined, { what: 'bucket secret access key', flag: 'LITESTREAM_SECRET_ACCESS_KEY', secret: true }))
  return { bucket, endpoint, access_key, secret_key }
}

const publicAddressFrom = async (options: Record<string, unknown>, tty: boolean, detect: () => Promise<DetectedAddress>) => {
  const given = options.publicAddress as string | undefined
  if (given && options.detectPublicAddress) throw usage('--public-address and --detect-public-address exclude each other.', 'Pass one of them.')
  if (given) {
    const problem = ipv4Problem(given)
    if (problem) throw usage(`${given}: ${problem}.`, 'Pass --public-address with the host\'s public IPv4 address.')
    return given
  }
  if (options.detectPublicAddress) {
    const found = await detect()
    if (!found.address || !found.public)
      throw usage(found.address ? `${found.interface} has ${found.address}, which is not a public address.` : `no address detected: ${found.reason ?? 'unknown reason'}.`, 'Pass --public-address with the address the internet reaches this host on.')
    return found.address
  }
  if (!tty) return undefined
  const found = await detect()
  if (found.address && found.public) process.stderr.write(`  the default-route interface ${found.interface} has the public address ${found.address}\n`)
  else process.stderr.write(`  ${found.address ? `the default-route interface ${found.interface} has ${found.address}, which is not a public address (private, CGNAT or reserved)` : `no address detected (${found.reason ?? 'no reason given'})`}\n`)
  const entered = await askUntil(found.address && found.public ? 'station public IPv4 address (Enter to accept, or type another)' : 'station public IPv4 address (Enter to skip)', v => (!v ? null : ipv4Problem(v)), found.address && found.public ? found.address : '')
  return entered || undefined
}

export const hostCommands = (program: Command) => {
  program
    .command('setup')
    .description('First-admin bootstrap on the station host, as root, through stationd\'s root socket')
    .option('--socket <path>', 'stationd root socket', defaultSocket)
    .option('--email <email>', 'admin email')
    .option('--password-stdin', 'read the admin password from stdin')
    .option('--acme-email <email>', 'ACME account email (acme.email)')
    .option('--api-host <host>', 'API hostname (hostnames.api)')
    .option('--dashboard-host <host>', 'dashboard hostname (hostnames.dashboard)')
    .option('--no-domain', 'skip the hostnames; Dispatch stays on the loopback publish')
    .option('--public-address <ipv4>', 'the station\'s public IPv4 address (station.public_address)')
    .option('--detect-public-address', 'use the IPv4 address of the default-route interface when it is public; no lookup service is contacted')
    .option('--litestream-bucket <bucket>', 'bucket for an off-host copy of Dispatch, replicated by the Litestream sidecar')
    .option('--litestream-endpoint <url>', 'S3-compatible endpoint of the bucket: https, or http on a private address (default AWS S3)')
    .option('--litestream-access-key <id>', 'bucket access key id (or LITESTREAM_ACCESS_KEY_ID); the secret comes from LITESTREAM_SECRET_ACCESS_KEY')
    .action(
      action(async options => {
        const tty = interactive()
        const prompted = tty && !(options.email && options.passwordStdin && (options.domain === false || (options.apiHost && options.dashboardHost)) && (options.publicAddress || options.detectPublicAddress))
        if (prompted) process.stderr.write('Stationly setup: this creates the single admin and puts Dispatch on its hostnames. Ctrl-C cancels; nothing is created before the last question.\n\n')
        const email = ((options.email as string | undefined) ?? (tty ? await askUntil('admin email', emailProblem) : await need(undefined, { what: 'admin email', flag: '--email' }))).trim()
        if (emailProblem(email)) throw usage(`${email} is not an email address.`, 'Pass --email with the admin address.')
        let password: string
        if (options.passwordStdin) password = await readStdin()
        else if (tty) password = await askPassword()
        else password = await need(undefined, { what: 'admin password', flag: '--password-stdin', secret: true })
        if (password.length < minPassword) throw usage(`The password needs at least ${minPassword} characters.`, 'Choose a longer password.')
        const domain = options.domain === false ? false : options.apiHost || options.dashboardHost || !tty ? true : await confirm('Serve the dashboard and API on hostnames of your own domain? (No: domainless, reached through an SSH forward)')
        const pair = domain ? await hostnamePair(options.apiHost as string | undefined, options.dashboardHost as string | undefined, tty) : null
        const acme = (options.acmeEmail as string | undefined) ?? (tty ? await askUntil(pair ? 'ACME email for Let\'s Encrypt' : 'ACME email for Let\'s Encrypt (optional, Enter to skip)', v => (!v && !pair) || !emailProblem(v) ? null : 'that is not an email address', pair ? email : '') : pair ? await need(undefined, { what: 'ACME email for Let\'s Encrypt', flag: '--acme-email' }) : undefined)
        const detect = async () => (await rootSocketCall(options.socket as string, 'public_address.detect', {}, () => {})) as DetectedAddress
        const publicAddress = await publicAddressFrom(options, tty, detect)
        const litestream = await litestreamFrom(options, tty)
        if (prompted) {
          process.stderr.write(
            [
              '',
              `  admin          ${email}`,
              pair ? `  API host       ${pair.api}` : '  hostnames      none (domainless; SSH forward to 127.0.0.1:7900)',
              pair ? `  dashboard host ${pair.dashboard} (passkey RP ID ${pair.parent})` : null,
              `  ACME email     ${acme || 'none'}`,
              `  public address ${publicAddress ?? 'none (set it later with sly stations update)'}`,
              `  Litestream     ${litestream ? `${litestream.bucket}${litestream.endpoint ? ` at ${litestream.endpoint}` : ''}` : 'none'}`,
              ''
            ]
              .filter(line => line !== null)
              .join('\n') + '\n'
          )
          if (!(await confirm('Create the admin and apply these settings?'))) throw cancelled()
        }
        const params: Record<string, unknown> = {
          email,
          password,
          ...(acme ? { acme_email: acme } : {}),
          ...(pair ? { hostnames: { api: pair.api, dashboard: pair.dashboard } } : {}),
          ...(publicAddress ? { public_address: publicAddress } : {}),
          ...(litestream ? { litestream } : {})
        }
        const result = (await rootSocketCall(options.socket as string, 'setup', params, (step, detail) => {
          if (!options.json) process.stderr.write(`${step}: ${detail}\n`)
        })) as SetupResult
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
        if (!options.json && interactive()) {
          const stored = await need(undefined, { what: 'type "stored" once the recovery key is saved', flag: '--json' })
          if (stored !== 'stored') process.stderr.write('store the recovery key before closing this terminal; without it a restore marks every secret needs_reentry\n')
        }
        return exitCodes.ok
      })
    )
}

export const adminHostCommands = (program: Command) => {
  const admin = program.command('admin').description('Host-only administration, as root on the station host through stationd\'s root socket')
  admin
    .command('recovery-key')
    .description('Print the recovery key again; the display is audited')
    .option('--socket <path>', 'stationd root socket', defaultSocket)
    .action(
      action(async options => {
        const { recovery_key } = (await rootSocketCall(options.socket as string, 'admin.recovery_key', {}, () => {})) as { recovery_key: string }
        process.stdout.write(options.json ? `${JSON.stringify({ recovery_key }, null, 2)}\n` : `${recovery_key}\n`)
        if (!options.json) process.stderr.write('this display was recorded in the audit log; store the key offline\n')
        return exitCodes.ok
      })
    )
}
