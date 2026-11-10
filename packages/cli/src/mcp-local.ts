import type { CallToolResult } from '@modelcontextprotocol/server'

import type { LocalContext, LocalTool } from '@stationly/mcp'
import { portRange } from '@stationly/protocol'

import { connectWith, tokenCredentials } from './kit.ts'
import { uploadSource } from './push.ts'
import { forwardPort } from './sockets.ts'

const result = (body: unknown, isError = false): CallToolResult => ({
  ...(isError
    ? {
        isError: true,
      }
    : {
        structuredContent: body,
      }),
  content: [
    {
      type: 'text',
      text: JSON.stringify(body, null, 2),
    },
  ],
})

const idOf = async (context: LocalContext, tool: string, args: Record<string, unknown>) => {
  const found = await context.call(tool, args)
  return found.isError
    ? {
        refused: found,
      }
    : {
        id: (found.structuredContent as { id: string }).id,
      }
}

export const localTools = (instance: string, token: string, userAgent: string): LocalTool[] => {
  const run = connectWith({}, tokenCredentials(instance, token), {}, userAgent)
  const forwards = new Map<string, Promise<{ address: string; close: () => Promise<void> }>>()

  const pushLocalSource: LocalTool = {
    name: 'push_local_source',
    title: 'Push local source',
    description:
      'Upload a directory on the machine running sly mcp (honoring .dockerignore) as the source of a service with a local source, then deploy it. Returns the deployment; follow with wait_for_deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          minLength: 1,
          description: 'An id, or the names project/environment/service',
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'Directory to upload; absolute, or relative to where sly mcp runs',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['service', 'path'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Push local source',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (args, context) => {
      const service = await idOf(context, 'describe_service', {
        service: args.service,
      })
      if (service.refused) return service.refused
      const uploaded = await uploadSource(
        run,
        service.id,
        args.path as string,
        (message) => void context.progress(message),
      )
      if (uploaded.error) return result(uploaded.error.value, true)
      return context.call('deploy', {
        service: service.id,
        blob_id: uploaded.data.blob_id,
        ...(args.idempotency_key
          ? {
              idempotency_key: args.idempotency_key,
            }
          : {}),
      })
    },
  }

  const forwardSandboxPort: LocalTool = {
    name: 'forward_sandbox_port',
    title: 'Forward a sandbox port',
    description:
      'Listen on 127.0.0.1 of the machine running sly mcp and forward to a port of a running sandbox, for previews. The listener lasts until the stdio server exits or the sandbox stops, and a second call for the same sandbox and port returns the same listener.',
    inputSchema: {
      type: 'object',
      properties: {
        sandbox: {
          type: 'string',
          minLength: 1,
          description: 'An id, or the names project/environment/sandbox',
        },
        port: {
          type: 'integer',
          ...portRange,
          description: 'Port inside the sandbox',
        },
        local_port: {
          type: 'integer',
          minimum: 0,
          maximum: 65535,
          description: 'Local port; default the sandbox port when free, 0 for any',
        },
      },
      required: ['sandbox', 'port'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Forward a sandbox port',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (args, context) => {
      const sandbox = await idOf(context, 'get_sandbox', {
        sandbox: args.sandbox,
      })
      if (sandbox.refused) return sandbox.refused
      const port = args.port as number
      const key = `${sandbox.id}:${port}`
      const stopIfGone = async () => {
        const current = await run.api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          .get({
            query: {},
          })
        if (current.data?.status === 'running') return
        forwards.delete(key)
        await (await listener).close()
      }
      const listener =
        forwards.get(key) ??
        forwardPort(run, sandbox.id, port, args.local_port as number | undefined, {
          unopened: () => void stopIfGone(),
        }).then((forward) => {
          forward.server.unref()
          return forward
        })
      forwards.set(key, listener)
      const forward = await listener.catch((error) => {
        forwards.delete(key)
        throw error
      })
      return result({
        local_address: forward.address,
      })
    },
  }

  return [pushLocalSource, forwardSandboxPort]
}
