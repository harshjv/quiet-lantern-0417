import { Type } from '@sinclair/typebox'

import { tokenLevelValues } from './domain.ts'
import { networkLayout } from './network.ts'
import { StringEnum } from './primitives.ts'

export const workspaceAgentValues = ['claude', 'codex'] as const

export type WorkspaceAgent = (typeof workspaceAgentValues)[number]

type Entry = { domain: string; wildcard?: boolean; ports?: number[] }

const domains = (...names: string[]): Entry[] =>
  names.map((domain) => ({
    domain,
  }))

type AgentPreset = {
  package: string
  keys: string[]
  env: Record<string, string>
  config: { path: string; text: string } | null
  domains: Entry[]
}

export const workspaceAgents: Record<WorkspaceAgent, AgentPreset> = {
  claude: {
    package: '@anthropic-ai/claude-code',
    keys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    config: null,
    domains: domains('api.anthropic.com', 'claude.ai', 'platform.claude.com'),
  },
  codex: {
    package: '@openai/codex',
    keys: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
    env: {},
    config: {
      path: '.codex/config.toml',
      text: [
        'cli_auth_credentials_store = "ephemeral"',
        'check_for_update_on_startup = false',
        '',
        '[analytics]',
        'enabled = false',
        '',
        '[feedback]',
        'enabled = false',
        '',
      ].join('\n'),
    },
    domains: domains('api.openai.com', 'chatgpt.com', 'auth.openai.com'),
  },
}

export const workspaceSharedKeys = ['GH_TOKEN']

export const workspaceSharedDomains: Entry[] = [
  {
    domain: 'github.com',
    ports: [443, 22],
  },
  ...domains('api.github.com', 'codeload.github.com', 'ghcr.io'),
  {
    domain: 'githubusercontent.com',
    wildcard: true,
  },
  ...domains(
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'pypi.org',
    'files.pythonhosted.org',
    'proxy.golang.org',
    'sum.golang.org',
    'registry-1.docker.io',
    'auth.docker.io',
    'production.cloudflare.docker.com',
  ),
]

export const workspaceApiUrl = `http://169.254.1.1:${networkLayout.dispatchPort}`

export const workspaceRoot = '/workspaces'

export const workspaceUser = {
  name: 'agent',
  home: '/home/agent',
} as const

export const workspacePrefix = `${workspaceUser.home}/.local`

export const workspaceEnv = {
  token: 'STATIONLY_TOKEN',
  apiUrl: 'STATIONLY_API_URL',
} as const

export const workspaceEgress = (agent: WorkspaceAgent) => ({
  mode: 'allowlist' as const,
  domains: [...workspaceAgents[agent].domains, ...workspaceSharedDomains],
})

export const SandboxWorkspaceInput = Type.Object(
  {
    agent: StringEnum(workspaceAgentValues, {
      description: 'The agent CLI to install: claude or codex',
    }),
    repository: Type.String({
      pattern: '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~-]+)+$',
      description: 'The https git URL to clone into /workspaces/<repository>',
    }),
    branch: Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9._/-]+$',
        maxLength: 255,
        description: 'The branch or tag to check out after the clone',
      }),
    ),
    level: Type.Optional(
      StringEnum(tokenLevelValues, {
        description: "The level of the workspace's token on its project (default deploy)",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Make the sandbox a workspace: no time to live, the agent installed, the repository cloned and sly signed in with its own token',
  },
)
