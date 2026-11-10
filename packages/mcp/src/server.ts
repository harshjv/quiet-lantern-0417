import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'

import { internalEnvelope, invoke, type Send } from './invoke.ts'
import { visibleTo, type Caller, type Outcome, type ToolDef } from './tools.ts'

export const alwaysLoadKey = 'anthropic/alwaysLoad'

const text = (value: unknown) => JSON.stringify(value, null, 2)

const asObject = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {
        items: body,
      }

export const toResult = (outcome: Outcome): CallToolResult =>
  outcome.ok
    ? {
        content: [
          {
            type: 'text',
            text: text(outcome.body),
          },
        ],
        structuredContent: asObject(outcome.body),
      }
    : {
        isError: true,
        content: [
          {
            type: 'text',
            text: text(outcome.envelope),
          },
        ],
      }

export type ServerSpec = {
  name: string
  version: string
  instructions: string
  tools: ToolDef[]
  caller: Caller
  send: Send
}

export const buildServer = (spec: ServerSpec) => {
  const server = new McpServer(
    {
      name: spec.name,
      version: spec.version,
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      instructions: spec.instructions,
    },
  )
  for (const tool of spec.tools.filter((t) => visibleTo(spec.caller, t))) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema
          ? {
              outputSchema: tool.outputSchema,
            }
          : {}),
        annotations: tool.annotations,
        ...(tool.alwaysLoad
          ? {
              _meta: {
                [alwaysLoadKey]: true,
              },
            }
          : {}),
      },
      async (input, request) => {
        try {
          return toResult(await invoke(tool, input, spec.send, request))
        } catch (error) {
          return toResult({
            ok: false,
            envelope: internalEnvelope(error),
          })
        }
      },
    )
  }
  return server
}
