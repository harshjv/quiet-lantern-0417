import type { CallToolResult } from '@modelcontextprotocol/server'

import type { LocalContext, LocalTool } from '@stationly/mcp'

import { Exit } from './errors.ts'
import { connectWith, tokenCredentials } from './kit.ts'
import { uploadSource } from './push.ts'

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

  return [pushLocalSource]
}
