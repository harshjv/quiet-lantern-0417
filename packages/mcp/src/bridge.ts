import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { jsonSchema } from './schema.ts'

export const bridgeProtocolVersion = '2026-07-28'

export type LocalTool = {
  name: string
  title: string
  description: string
  inputSchema: JsonSchemaType
  annotations: Record<string, unknown>
  run: (args: Record<string, unknown>, context: LocalContext) => Promise<CallToolResult>
}

export type LocalContext = {
  progress: (message: string) => Promise<void>
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>
}

export type BridgeSpec = {
  url: URL
  token: string
  client: string
  version: string
  log: (event: string, data?: Record<string, unknown>) => void
  local?: LocalTool[]
}

const unauthenticated = (client: string, detail: string): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        error: {
          code: 'UNAUTHENTICATED',
          explanation: `Dispatch refused the scoped token for ${client}: ${detail}`,
          fix: `Run sly mcp install ${client} again to mint a fresh token.`,
        },
      }),
    },
  ],
})

const unreachable = (detail: string): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        error: {
          code: 'STATION_OFFLINE',
          explanation: `Dispatch could not be reached: ${detail}`,
          fix: 'Check the instance URL and that Dispatch is running, then retry.',
        },
      }),
    },
  ],
})

export const serveBridge = (spec: BridgeSpec) => {
  let remote: Promise<Client> | undefined
  const connect = () =>
    (remote ??= (async () => {
      const client = new Client(
        {
          name: spec.client,
          version: spec.version,
        },
        {
          versionNegotiation: {
            mode: {
              pin: bridgeProtocolVersion,
            },
          },
        },
      )
      await client.connect(
        new StreamableHTTPClientTransport(spec.url, {
          authProvider: {
            token: () => Promise.resolve(spec.token),
          },
          requestInit: {
            headers: {
              'user-agent': `mcp/${spec.client} sly/${spec.version}`,
            },
          },
        }),
      )
      spec.log('remote.connected', {
        url: spec.url.href,
        era: client.getProtocolEra(),
        version: client.getNegotiatedProtocolVersion(),
      })
      return client
    })().catch((error) => {
      remote = undefined
      throw error
    }))

  return serveStdio(
    async () => {
      const client = await connect()
      const { tools } = await client.listTools()
      const server = new McpServer(
        {
          name: 'stationly',
          version: spec.version,
        },
        {
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          instructions: client.getInstructions(),
        },
      )
      const forward = async (
        name: string,
        args: Record<string, unknown>,
        request: ServerContext,
        relay: boolean,
      ): Promise<CallToolResult> => {
        const progressToken = request.mcpReq._meta?.progressToken
        try {
          return await client.callTool(
            {
              name,
              arguments: args,
            },
            {
              signal: request.mcpReq.signal,
              timeout: 3_700_000,
              resetTimeoutOnProgress: true,
              onprogress:
                !relay || progressToken === undefined
                  ? undefined
                  : (progress) =>
                      void request.mcpReq.notify({
                        method: 'notifications/progress',
                        params: {
                          ...progress,
                          progressToken,
                        },
                      }),
            },
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          spec.log('remote.call_failed', {
            tool: name,
            error: detail,
          })
          return /401|unauthori[sz]ed/i.test(detail)
            ? unauthenticated(spec.client, detail)
            : unreachable(detail)
        }
      }
      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: jsonSchema(tool.inputSchema as JsonSchemaType),
            ...(tool.outputSchema
              ? {
                  outputSchema: jsonSchema(tool.outputSchema as JsonSchemaType),
                }
              : {}),
            annotations: tool.annotations,
            _meta: tool._meta,
          },
          (args, request) => forward(tool.name, args, request, true),
        )
      }
      for (const local of spec.local ?? []) {
        server.registerTool(
          local.name,
          {
            title: local.title,
            description: local.description,
            inputSchema: jsonSchema(local.inputSchema),
            annotations: local.annotations,
          },
          async (args, request) => {
            const progressToken = request.mcpReq._meta?.progressToken
            let step = 0
            const progress = async (message: string) => {
              if (progressToken !== undefined)
                await request.mcpReq.notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: ++step,
                    message,
                  },
                })
            }
            try {
              return await local.run(args, {
                progress,
                call: (name, input) => forward(name, input, request, false),
              })
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: {
                        code: 'INTERNAL_ERROR',
                        explanation: error instanceof Error ? error.message : String(error),
                        fix: 'Check the input and retry.',
                      },
                    }),
                  },
                ],
              }
            }
          },
        )
      }
      spec.log('factory', {
        tools: tools.length,
        local: spec.local?.length ?? 0,
      })
      return server
    },
    {
      legacy: 'serve',
      onerror: (error) =>
        spec.log('stdio.error', {
          message: error.message,
        }),
    },
  )
}
