import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { serveBridge } from '@stationly/mcp'
import { localTools } from '../mcp-local.ts'
import type { Command } from 'commander'
import { action, seconds } from '../command.ts'
import { readCredentials, updateCredentials } from '../config.ts'
import { Exit, exitCodes, inputRequired, notLoggedIn, usage } from '../errors.ts'
import { connect, environmentId, isLevel, resolveInstance, send } from '../kit.ts'
import { print, progress } from '../output.ts'
import { version } from '../env.ts'

const clients = ['claude-code', 'cursor', 'codex', 'windsurf', 'generic'] as const

const launcher = async (client: string) => {
  const script = process.argv[1] ? await realpath(process.argv[1]) : null
  const installed = !script || basename(process.argv[1]!) === 'sly'
  return installed
    ? { command: 'sly', args: ['mcp', '--client', client] }
    : { command: process.execPath, args: [script, 'mcp', '--client', client] }
}

const writeClaudeCode = async (server: { command: string; args: string[] }) => {
  const path = join(process.cwd(), '.mcp.json')
  const existing = await readFile(path, 'utf8').then(
    text => JSON.parse(text) as { mcpServers?: Record<string, unknown> },
    (error: NodeJS.ErrnoException): { mcpServers?: Record<string, unknown> } => {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  )
  await writeFile(path, `${JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, stationly: server } }, null, 2)}\n`)
  return path
}

const expired = (expiresAt: string) => new Date(expiresAt).getTime() <= Date.now()

export const mcpCommands = (program: Command) => {
  const mcp = program
    .command('mcp')
    .description('Serve MCP on stdio, bridged to the instance /mcp with the scoped token of --client')
    .option('--client <client>', 'the client whose token sly mcp install minted')
    .action(
      action(async options => {
        const { instance } = await resolveInstance(options)
        if (!instance) throw notLoggedIn(null)
        const credentials = await readCredentials(instance)
        if (!credentials) throw notLoggedIn(instance)
        const names = Object.keys(credentials.mcp)
        const client = (options.client as string | undefined) ?? (names.length === 1 ? names[0] : undefined)
        if (!client) throw inputRequired('The MCP client', `--client <${names.join('|') || 'client'}>`)
        const stored = credentials.mcp[client]
        if (!stored || expired(stored.expires_at)) {
          throw new Exit(exitCodes.connection, {
            error: {
              code: 'UNAUTHENTICATED',
              explanation: stored ? `The scoped token for ${client} expired at ${stored.expires_at}.` : `No scoped token is stored for ${client}.`,
              fix: `Run sly mcp install ${client} again.`
            }
          })
        }
        const log = (event: string, data: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ event, ...data })}\n`)
        serveBridge({ url: new URL('/mcp', instance), token: stored.token, client, version, log, local: localTools(instance, stored.token, `mcp/${client} sly/${version}`) })
        return new Promise<number>(() => {})
      })
    )

  mcp
    .command('install')
    .argument('<client>', clients.join(', '))
    .option('--level <level>', 'read, deploy or admin', 'deploy')
    .option('--ttl <duration>', 'token lifetime, at most 30d', seconds, 30 * 86400)
    .action(
      action(async (options, client) => {
        if (!clients.includes(client as (typeof clients)[number])) throw usage(`${client} is not a supported client.`, `Pass one of ${clients.join(', ')}.`)
        const level = options.level as string
        if (!isLevel(level)) throw usage(`--level ${options.level} is not read, deploy or admin.`, 'Pass --level read, deploy or admin.')
        const run = await connect(options)
        const projectRef = run.selection.project
        if (!projectRef) throw inputRequired('The project the token covers', "--project <id or name>, or --project '*'")
        const project = projectRef === '*' ? '*' : (await run.get<{ id: string }>(`/v1/projects/${encodeURIComponent(projectRef)}`)).id
        const environment = !run.selection.environment || run.selection.environment === '*' ? '*' : await environmentId(run)
        const sent = await send(run.api.v1.tokens.post({ name: `mcp/${client}`, kind: 'scoped', scopes: [{ project_id: project, environment_id: environment, level }], expires_in_s: options.ttl as number }))
        const minted = sent.data as { id: string; key: string; expires_at: string }
        const previous = run.credentials.mcp[client!]
        await updateCredentials({ ...run.credentials, mcp: { ...run.credentials.mcp, [client!]: { token: minted.key, token_id: minted.id, expires_at: minted.expires_at } } })
        if (previous && previous.token_id !== minted.id) {
          const revoked = await run.api.v1.tokens({ id: previous.token_id }).delete()
          progress(revoked.error ? `the previous token ${previous.token_id} was not revoked` : `revoked the previous token ${previous.token_id}`)
        }
        const server = await launcher(client!)
        const { key: _key, ...shown } = minted
        if (client === 'claude-code') {
          const path = await writeClaudeCode(server)
          progress(`wrote the Stationly server to ${path}; the token ${minted.id} is stored in sly's credentials, never in that file`)
          return print(options, { status: sent.status, data: { token: shown, config: path, server } })
        }
        progress(`add this server to the ${client} configuration; the token ${minted.id} is stored in sly's credentials`)
        return print({ ...options, json: true }, { status: sent.status, data: { mcpServers: { stationly: server } } })
      })
    )
}
