import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { action, call, type Program } from '../command.ts'
import {
  normalizeInstance,
  readCredentials,
  removeCredentials,
  saveCredentials,
  type Credentials,
} from '../config.ts'
import { Exit, exitCodes, notLoggedIn, unreachable, type EnvelopeCode } from '../errors.ts'
import { connectWith, credentialHeaders, resolveInstance, send, userAgent } from '../kit.ts'
import { print, progress } from '../output.ts'
import { need, readStdin } from '../prompt.ts'
import { newMachineKey, proofFor, type MachineKey } from '../proof.ts'

type DeviceCode = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

type DeviceToken = {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'

const refused = (code: EnvelopeCode, explanation: string, fix: string) =>
  new Exit(exitCodes.connection, {
    error: {
      code,
      explanation,
      fix,
    },
  })

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': userAgent,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw unreachable(url, error)
  }
}

const openBrowser = (url: string) => {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    return
  }
}

const deviceLogin = async (instance: string, browser: boolean) => {
  const key: MachineKey = newMachineKey()
  const started = await post(`${instance}/auth/device/code`, {
    client_id: 'sly',
  })
  if (!started.ok)
    throw refused(
      'UNAUTHENTICATED',
      `Dispatch refused to start device authorization (HTTP ${started.status}).`,
      'Check the instance URL; sly login needs the API host.',
    )
  const code = (await started.json()) as DeviceCode
  const link = code.verification_uri_complete ?? code.verification_uri
  progress(`To approve this login, open ${link}`)
  progress(
    `and check that it shows the code ${code.user_code}. A passkey, or password plus TOTP, is required.`,
  )
  if (browser) openBrowser(link)
  let interval = Math.max(code.interval ?? 5, 1)
  const deadline = Date.now() + code.expires_in * 1000
  const tokenUrl = `${instance}/auth/device/token`
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const polled = await post(
      tokenUrl,
      {
        grant_type: deviceGrant,
        device_code: code.device_code,
        client_id: 'sly',
      },
      {
        dpop: proofFor(key, 'POST', tokenUrl),
      },
    )
    const body = (await polled.json().catch(() => ({}))) as DeviceToken
    if (polled.ok && body.access_token)
      return {
        token: body.access_token,
        expiresIn: body.expires_in ?? 0,
        key,
      }
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval += 5
      continue
    }
    if (body.error === 'access_denied')
      throw refused(
        'UNAUTHENTICATED',
        'The login was denied in the browser.',
        'Run sly login again and approve the code that sly prints.',
      )
    if (body.error === 'expired_token') break
    throw refused(
      'UNAUTHENTICATED',
      `Device authorization failed: ${body.error ?? `HTTP ${polled.status}`}${body.error_description ? ` (${body.error_description})` : ''}.`,
      'Run sly login again.',
    )
  }
  throw refused(
    'UNAUTHENTICATED',
    'The login code expired before it was approved.',
    'Run sly login again and approve within 10 minutes.',
  )
}

export const authCommands = (program: Program) => {
  program
    .command('login')
    .description(
      'Interactive device authorization: approve in a browser and get a 12 hour session bound to this machine; --with-token stores a token instead',
    )
    .option('--no-browser', 'print the approval link and code instead of opening a browser')
    .option(
      '--with-token',
      'read a personal or scoped token from stdin instead of logging in interactively',
    )
    .action(
      action(async (options) => {
        const { instance: chosen } = await resolveInstance(options)
        const instance = normalizeInstance(
          await need(chosen ?? undefined, {
            what: 'Instance URL',
            flag: '--instance <https://api host>',
          }),
        )
        const previous = await readCredentials(instance)
        let credentials: Credentials
        if (options.withToken) {
          const token = await readStdin()
          credentials = {
            instance,
            kind: 'token',
            token,
            token_id: null,
            expires_at: null,
            proof_key: null,
            mcp: previous?.mcp ?? {},
          }
        } else {
          const session = await deviceLogin(instance, options.browser)
          credentials = {
            instance,
            kind: 'session',
            token: session.token,
            token_id: null,
            expires_at: new Date(Date.now() + session.expiresIn * 1000).toISOString(),
            proof_key: session.key,
            mcp: previous?.mcp ?? {},
          }
        }
        const run = connectWith(options, credentials)
        const sent = await send(run.api.v1.me.get())
        const me = sent.data
        await saveCredentials({
          ...credentials,
          token_id: me.token_kind === 'session' ? null : me.actor.id,
          expires_at: me.expires_at,
        })
        progress(
          `logged in to ${instance} as ${me.actor.type} ${me.actor.id} (${me.token_kind}${me.human ? ', human' : ''}, expires ${me.expires_at})`,
        )
        return print(options, sent)
      }),
    )

  program
    .command('logout')
    .description('Revoke the sly session on the instance, then forget it and its machine key')
    .action(
      action(async (options) => {
        const { instance } = await resolveInstance(options)
        const credentials = instance ? await readCredentials(instance) : null
        if (!instance || !credentials) throw notLoggedIn(instance)
        let revoked: boolean | null = null
        if (credentials.kind === 'session') {
          const url = `${instance}/auth/sign-out`
          const response = await post(url, {}, credentialHeaders(credentials, 'POST', url))
          revoked = response.ok
          if (!response.ok && response.status !== 401)
            progress(
              `the instance answered HTTP ${response.status} to sign-out; the local session is forgotten anyway`,
            )
        }
        await removeCredentials(instance)
        progress(`logged out of ${instance}${revoked ? '; the session is revoked' : ''}`)
        if (options.json)
          process.stdout.write(
            `${JSON.stringify({
              logged_out: instance,
              session_revoked: revoked,
            })}\n`,
          )
        return exitCodes.ok
      }),
    )

  program
    .command('whoami')
    .description('The caller: actor, human flag, token kind, scopes and expiry')
    .action(call(async (run) => run.api.v1.me.get()))
}
