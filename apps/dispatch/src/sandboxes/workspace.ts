import type { Static } from '@sinclair/typebox'
import { isNotNull } from 'drizzle-orm'

import {
  slugPattern,
  workspaceAgents,
  workspaceApiUrl,
  workspaceEnv,
  workspacePrefix,
  workspaceRoot,
  workspaceSharedKeys,
  workspaceUser,
  type Actor,
  type SandboxVariableSet,
  type WorkspaceAgent,
} from '@stationly/protocol'

import { scopedTokenMaxSeconds, type AuthService } from '../auth/auth.ts'
import { dropToken, extendToken, tokenRow } from '../auth/tokens.ts'
import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { sandbox, type SandboxWorkspace } from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'
import { variablesOf } from '../secrets/values.ts'

type ActorValue = Static<typeof Actor>

const renewalActor: ActorValue = {
  type: 'system',
  id: null,
  client: 'dispatch/workspaces',
}

const renewBelowMs = (scopedTokenMaxSeconds * 1000) / 2

const toolchainFiles = [
  'mise.toml',
  '.mise.toml',
  '.config/mise.toml',
  'mise.local.toml',
  '.tool-versions',
]

const setupScript = [
  'set -euo pipefail',
  'export HOME="$5"',
  'npm install --global --prefix "$6" --no-fund --no-audit "$1"',
  'if [ -n "$7" ] && [ ! -e "$HOME/$7" ]; then mkdir -p "$(dirname "$HOME/$7")" && printf \'%s\' "$8" >"$HOME/$7"; fi',
  'if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git; fi',
  'if [ ! -d "$3/.git" ]; then git clone "$2" "$3"; fi',
  'if [ -n "$4" ]; then git -C "$3" checkout "$4"; fi',
  'toolchain=0',
  `for file in ${toolchainFiles.join(' ')}; do if [ -f "$3/$file" ]; then toolchain=1; fi; done`,
  'if [ "$toolchain" = 1 ]; then (cd "$3" && mise trust --all && mise install --yes); fi',
].join('\n')

export const repositoryName = (repository: string) =>
  repository
    .split('/')
    .at(-1)!
    .replace(/\.git$/, '')
    .toLowerCase()

export const isRepositoryName = (name: string) => new RegExp(slugPattern).test(name)

export const workspacePath = (repository: string) =>
  `${workspaceRoot}/${repositoryName(repository)}`

export const setupCommand = (
  workspace: Pick<SandboxWorkspace, 'agent' | 'repository' | 'branch' | 'path'>,
) => [
  'bash',
  '-c',
  setupScript,
  'workspace-setup',
  workspaceAgents[workspace.agent].package,
  workspace.repository,
  workspace.path,
  workspace.branch ?? '',
  workspaceUser.home,
  workspacePrefix,
  workspaceAgents[workspace.agent].config?.path ?? '',
  workspaceAgents[workspace.agent].config?.text ?? '',
]

export const workspaceVariableSets = (
  db: Db,
  context: { project: string; environment: string },
  agent: WorkspaceAgent,
  key: string,
  taken: string[],
): Static<typeof SandboxVariableSet>[] => {
  const defined = new Set(
    variablesOf(db, {
      scope: 'project',
      id: context.project,
    })
      .all()
      .map((v) => v.key),
  )

  return [
    {
      key: workspaceEnv.token,
      kind: 'sealed',
      value: key,
    },
    {
      key: workspaceEnv.apiUrl,
      kind: 'literal',
      value: workspaceApiUrl,
    },
    {
      key: workspaceEnv.project,
      kind: 'literal',
      value: context.project,
    },
    {
      key: workspaceEnv.environment,
      kind: 'literal',
      value: context.environment,
    },
    ...Object.entries(workspaceAgents[agent].env)
      .filter(([name]) => !taken.includes(name))
      .map(([name, value]) => ({
        key: name,
        kind: 'literal' as const,
        value,
      })),
    ...[...workspaceAgents[agent].keys, ...workspaceSharedKeys]
      .filter((name) => defined.has(name) && !taken.includes(name))
      .map((name) => ({
        key: name,
        kind: 'reference' as const,
        reference: `\${{project.${name}}}`,
      })),
  ]
}

export const revokeWorkspaceToken = (
  db: Db,
  row: { workspace: SandboxWorkspace | null },
  actor: ActorValue,
) => {
  const found = row.workspace ? tokenRow(db, row.workspace.token_id) : undefined

  if (!found) {
    return
  }

  dropToken(db, found)
  recordAudit(db, {
    actor,
    action: 'token.revoke',
    target: {
      entity: 'token',
      id: found.id,
    },
    before: {
      name: found.name,
      kind: found.kind,
    },
  })
}

export const renewWorkspaceTokens = async (
  deps: { db: Db; auth: AuthService },
  now = new Date(),
) => {
  const { db } = deps
  const renewed: string[] = []

  for (const { workspace } of db
    .select({
      workspace: sandbox.workspace,
    })
    .from(sandbox)
    .where(isNotNull(sandbox.workspace))
    .all()) {
    const found = tokenRow(db, workspace!.token_id)

    if (!found || found.expires_at.getTime() - now.getTime() > renewBelowMs) {
      continue
    }

    const expires = await extendToken(deps.auth, db, found, scopedTokenMaxSeconds)

    recordAudit(db, {
      actor: renewalActor,
      action: 'token.renew',
      target: {
        entity: 'token',
        id: found.id,
      },
      before: {
        expires_at: found.expires_at.toISOString(),
      },
      after: {
        expires_at: expires.toISOString(),
      },
    })
    renewed.push(found.id)
  }

  return renewed
}

export const startWorkspaceTokenRenewal = (deps: { db: Db; auth: AuthService }, log: Log) =>
  every(3600, 'workspace.token_renewal_failed', log, async () => {
    const renewed = await renewWorkspaceTokens(deps)

    if (renewed.length) {
      log('workspace.tokens_renewed', {
        tokens: renewed,
      })
    }
  })
