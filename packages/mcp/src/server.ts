import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toolInput } from './schema.ts'
import { annotationsOf, visibleTo, type Caller, type Outcome, type ToolDef } from './tools.ts'

export const alwaysLoadKey = 'anthropic/alwaysLoad'

const text = (value: unknown) => JSON.stringify(value, null, 2)

const asObject = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : { items: body }

export const toResult = (outcome: Outcome): CallToolResult =>
  outcome.ok
    ? { content: [{ type: 'text', text: text(outcome.body) }], structuredContent: asObject(outcome.body) }
    : { isError: true, content: [{ type: 'text', text: text(outcome.envelope) }] }

export const internalEnvelope = (error: unknown) => ({
  error: {
    code: 'INTERNAL_ERROR',
    explanation: error instanceof Error ? error.message : String(error),
    fix: 'Retry; if it keeps failing, report the explanation.'
  }
})

export type ServerSpec<C> = {
  name: string
  version: string
  instructions: string
  tools: ToolDef<C>[]
  caller: Caller
  context: C
}

export const buildServer = <C>(spec: ServerSpec<C>) => {
  const server = new McpServer({ name: spec.name, version: spec.version }, { capabilities: { tools: { listChanged: false } }, instructions: spec.instructions })
  for (const tool of spec.tools.filter(t => visibleTo(spec.caller, t))) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toolInput(tool.input),
        annotations: annotationsOf(tool.family, tool.title),
        ...(tool.alwaysLoad ? { _meta: { [alwaysLoadKey]: true } } : {})
      },
      async (input, request) => {
        try {
          return toResult(await tool.run(spec.context, input as Record<string, unknown>, request))
        } catch (error) {
          return toResult({ ok: false, envelope: internalEnvelope(error) })
        }
      }
    )
  }
  return server
}
