import { Type } from '@sinclair/typebox'

import { tokenLevelValues } from './domain.ts'
import { networkLayout } from './network.ts'
import { StringEnum } from './primitives.ts'
import { releaseConfig } from './release-config.ts'

export const workspaceAgentValues = ['claude', 'codex'] as const

export type WorkspaceAgent = (typeof workspaceAgentValues)[number]

type Entry = { domain: string; wildcard?: boolean; ports?: number[] }

const domains = (...names: string[]): Entry[] =>
  names.map((domain) => ({
    domain,
  }))

type AgentModel = { id: string; label: string }

type AgentPreset = {
  label: string
  keyLabel: string
  keyHelp: string
  models: AgentModel[]
  runner: boolean
  package: string
  keys: string[]
  env: Record<string, string>
  config: { path: string; text: string } | null
  domains: Entry[]
}

export const workspaceAgents: Record<WorkspaceAgent, AgentPreset> = {
  claude: {
    label: 'Claude Code',
    keyLabel: 'Claude key',
    keyHelp: 'Run claude setup-token to get one, or paste an Anthropic API key.',
    models: [
      {
        id: 'claude-sonnet-5-5',
        label: 'Sonnet 5.5',
      },
      {
        id: 'claude-opus-5-5',
        label: 'Opus 5.5',
      },
      {
        id: 'claude-fable-5-2',
        label: 'Fable 5.2',
      },
      {
        id: 'claude-haiku-5-5',
        label: 'Haiku 5.5',
      },
    ],
    runner: true,
    package: '@anthropic-ai/claude-code',
    keys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    config: null,
    domains: domains('api.anthropic.com', 'claude.ai', 'platform.claude.com'),
  },
  codex: {
    label: 'Codex',
    keyLabel: 'Codex key',
    keyHelp: 'Paste an OpenAI API key for Codex.',
    models: [],
    runner: false,
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

export const agentLabel = (agent: string) =>
  agent in workspaceAgents ? workspaceAgents[agent as WorkspaceAgent].label : agent

export const modelLabel = (model: string) =>
  Object.values(workspaceAgents)
    .flatMap((agent) => agent.models)
    .find((entry) => model.startsWith(entry.id))?.label ?? model

export const workspaceSharedKeys = ['GH_TOKEN']

export const workspaceToolchainHosts = [
  'mise.jdx.dev',
  'mise-versions.jdx.dev',
  'nodejs.org',
  'dl.google.com',
  'go.dev',
  'storage.googleapis.com',
  new URL(releaseConfig.tuf_mirror).hostname,
  'rekor.sigstore.dev',
]

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
    'production.cloudfront.docker.com',
    ...workspaceToolchainHosts,
  ),
]

export const workspaceSizeDefaults = {
  memory_bytes: 2147483648,
} as const

export const workspaceSetupStepValues = [
  'agent',
  'config',
  'git_auth',
  'clone',
  'checkout',
  'toolchain',
] as const

export type WorkspaceSetupStep = (typeof workspaceSetupStepValues)[number]

export const workspaceSetupSteps: Record<WorkspaceSetupStep, string> = {
  agent: 'install the agent',
  config: "write the agent's configuration",
  git_auth: 'set up git sign-in',
  clone: 'clone the repository',
  checkout: 'check out the branch',
  toolchain: "install the repository's toolchain",
}

export const setupFailedMarker = 'setup-failed:'

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
  project: 'STATIONLY_PROJECT',
  environment: 'STATIONLY_ENVIRONMENT',
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
