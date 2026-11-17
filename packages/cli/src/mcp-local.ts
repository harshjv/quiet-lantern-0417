import type { CallToolResult } from '@modelcontextprotocol/server'

import type { LocalContext, LocalTool } from '@stationly/mcp'
import { portRange } from '@stationly/protocol'

import { Exit } from './errors.ts'
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
      'Upload a directory on the machine running sly mcp (honoring .dockerignore) as the source of an app with a local source, then deploy it. Returns the deployment; follow with wait_for_deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          minLength: 1,
          description: 'An id, or the names project/app, or project/preview/app in a preview',
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
      required: ['app', 'path'],
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
      const app = await idOf(context, 'describe_app', {
        app: args.app,
      })

      if (app.refused) {
        return app.refused
      }

      try {
        const uploaded = await uploadSource(
          run,
          app.id,
          args.path as string,
          (message) => void context.progress(message),
        )

        return await context.call('deploy', {
          app: app.id,
          blob_id: uploaded.data.blob_id,
          ...(args.idempotency_key
            ? {
                idempotency_key: args.idempotency_key,
              }
            : {}),
        })
      } catch (error) {
        if (error instanceof Exit && error.envelope) {
          return result(error.envelope, true)
        }

        throw error
      }
    },
  }

  const forwardMachinePort: LocalTool = {
    name: 'forward_machine_port',
    title: 'Forward a machine port',
    description:
      'Listen on 127.0.0.1 of the machine running sly mcp and forward to a port of a running machine, for previews. The listener lasts until the stdio server exits or the machine stops, and a second call for the same machine and port returns the same listener.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: {
          type: 'string',
          minLength: 1,
          description:
            'An id, or the names project/machine, or project/preview/machine in a preview',
        },
        port: {
          type: 'integer',
          ...portRange,
          description: 'Port inside the machine',
        },
        local_port: {
          type: 'integer',
          minimum: 0,
          maximum: 65535,
          description: 'Local port; default the machine port when free, 0 for any',
        },
      },
      required: ['machine', 'port'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Forward a machine port',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (args, context) => {
      const machine = await idOf(context, 'get_machine', {
        machine: args.machine,
      })

      if (machine.refused) {
        return machine.refused
      }

      const port = args.port as number
      const key = `${machine.id}:${port}`
      const stopIfGone = async () => {
        const current = await run.api.v1
          .machines({
            machine: machine.id,
          })
          .get({
            query: {},
          })

        if (current.data?.status === 'running') {
          return
        }

        forwards.delete(key)
        await (await listener).close()
      }
      const listener =
        forwards.get(key) ??
        forwardPort(run, machine.id, port, args.local_port as number | undefined, {
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

  return [pushLocalSource, forwardMachinePort]
}
