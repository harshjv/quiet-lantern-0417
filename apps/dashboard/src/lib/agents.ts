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
    after:
      'It writes .mcp.json there. Restart Claude Code and approve the stationly server when it asks.',
  },
  cursor: {
    after:
      'Add the server it prints to .cursor/mcp.json in your repository, or to ~/.cursor/mcp.json for every project. Then reload Cursor.',
    snippet: {
      caption: '.cursor/mcp.json',
      code: server('cursor'),
    },
  },
  codex: {
    after: 'Then register the server with Codex, which writes it to ~/.codex/config.toml.',
    follow: 'codex mcp add stationly -- sly mcp --client codex',
  },
  windsurf: {
    after:
      'Windsurf is now Devin Desktop. Add the server to ~/.config/devin/mcp_config.json, or to .devin/mcp_config.json in your repository.',
    snippet: {
      caption: 'mcp_config.json',
      code: server('windsurf'),
    },
  },
  generic: {
    after:
      'Add the server it prints to your client’s MCP settings. The client starts sly on your computer and talks to it over stdio.',
    snippet: {
      caption: 'MCP server definition',
      code: server('generic'),
    },
  },
}
