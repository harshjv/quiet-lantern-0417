import { releaseConfig } from '@stationly/protocol/release-config'

import type { McpClient } from './labels'

export const installSly = `curl -fsSL ${releaseConfig.installer_url}/install-sly.sh | sh`

export const checkPrompt = 'Use Stationly’s whoami tool and tell me which projects you can reach.'

export const expiries = [
  {
    ttl: '1d',
    label: '1 day',
  },
  {
    ttl: '7d',
    label: '7 days',
  },
  {
    ttl: '30d',
    label: '30 days',
  },
] as const

export type Expiry = (typeof expiries)[number]['ttl']

const server = (client: McpClient) =>
  JSON.stringify(
    {
      mcpServers: {
        stationly: {
          command: 'sly',
          args: ['mcp', '--client', client],
        },
      },
    },
    null,
    2,
  ).replace(/\[\s+([^\]]+?)\s+\]/, (_, items: string) => `[${items.split(/,\s+/).join(', ')}]`)

type Setup = {
  inRepository?: true
  after: string
  follow?: string
  snippet?: { caption: string; code: string }
}

export const setup: Record<McpClient, Setup> = {
  'claude-code': {
    inRepository: true,
    after: 'Restart Claude Code and approve the stationly server.',
  },
  cursor: {
    after: 'Add the printed server to .cursor/mcp.json, then reload Cursor.',
    snippet: {
      caption: '.cursor/mcp.json',
      code: server('cursor'),
    },
  },
  codex: {
    after: 'Then register the server with Codex.',
    follow: 'codex mcp add stationly -- sly mcp --client codex',
  },
  windsurf: {
    after: 'Add the printed server to ~/.config/devin/mcp_config.json in Devin Desktop.',
    snippet: {
      caption: 'mcp_config.json',
      code: server('windsurf'),
    },
  },
  generic: {
    after: 'Add the printed server to your client’s MCP settings.',
    snippet: {
      caption: 'MCP server definition',
      code: server('generic'),
    },
  },
}
