import type { Static } from '@sinclair/typebox'
import { isNotNull } from 'drizzle-orm'

import {
  setupFailedMarker,
  slugPattern,
  workspaceAgents,
  workspaceApiUrl,
  workspaceEnv,
  workspacePrefix,
  workspaceRoot,
  workspaceSharedKeys,
  workspaceUser,
  type Actor,
  type MachineKeySet,
  type TaskMachineValue,
  type WorkspaceAgent,
  type WorkspaceSetupStep,
} from '@stationly/protocol'

import { scopedTokenMaxSeconds, type AuthService } from '../auth/auth.ts'
import { dropToken, extendToken, tokenRow } from '../auth/tokens.ts'
import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import {
  machine,
  machine_user,
  type MachineWorkspace,
  type WorkspaceCleanup,
} from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'
import { keysOf } from '../secrets/values.ts'

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

const stepLine = (step: WorkspaceSetupStep) => `step=${step}`

const gitIdentity = (name: string, email: string) =>
  `if [ -n ${name} ] && [ -z "$(git config --global user.name || true)" ]; then git config --global user.name ${name}; git config --global user.email ${email}; fi`

export type GitIdentity = { name: string; email: string }

const setupScript = [
  'set -euo pipefail',
  `trap 'code=$?; if [ "$code" -ne 0 ]; then echo "${setupFailedMarker}$step" >&2; fi' EXIT`,
  stepLine('agent'),
  'export HOME="$5"',
  'npm install --global --prefix "$6" --no-fund --no-audit "$1"',
  stepLine('config'),
  'if [ -n "$7" ] && [ ! -e "$HOME/$7" ]; then mkdir -p "$(dirname "$HOME/$7")" && printf \'%s\' "$8" >"$HOME/$7"; fi',
  stepLine('git_auth'),
  'if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git; fi',
  gitIdentity('"${10:-}"', '"${11:-}"'),
  stepLine('clone'),
  'if [ -n "$2" ] && [ ! -d "$3/.git" ]; then git clone "$2" "$3"; fi',
  stepLine('checkout'),
  'if [ -n "$4" ]; then git -C "$3" checkout "$4"; fi',
  stepLine('branch'),
  'if [ -n "$9" ] && [ "$(git -C "$3" branch --show-current)" != "$9" ] && ! git -C "$3" symbolic-ref -q HEAD | grep -q "^refs/heads/$9-[0-9]*$"; then name="$9"; n=2; while git -C "$3" show-ref --verify --quiet "refs/heads/$name" || git -C "$3" ls-remote --exit-code --heads origin "$name" >/dev/null 2>&1; do name="$9-$n"; n=$((n + 1)); done; git -C "$3" switch -c "$name"; fi',
  stepLine('toolchain'),
  'toolchain=0',
  `for file in ${toolchainFiles.join(' ')}; do if [ -f "$3/$file" ]; then toolchain=1; fi; done`,
  'if [ "$toolchain" = 1 ]; then (cd "$3" && mise trust --all && mise install --yes); fi',
].join('\n')

const cleanupLoop = [
  'while IFS="$(printf \'\\t\')" read -r old_clone old_worktree old_branch; do',
  '  if [ -z "$old_clone" ]; then continue; fi',
  '  git -C "$old_clone" worktree remove --force "$old_worktree" 2>/dev/null || rm -rf "$old_worktree"',
  '  git -C "$old_clone" branch -D "$old_branch" >/dev/null 2>&1 || true',
  '  git -C "$old_clone" worktree prune 2>/dev/null || true',
  'done <<<"$cleanup"',
].join('\n')

const taskSetupScript = [
  'set -euo pipefail',
  `trap 'code=$?; if [ "$code" -ne 0 ]; then echo "${setupFailedMarker}$step" >&2; fi' EXIT`,
  'repository="$1" clone="$2" worktree="$3" base="$4" wanted="$5" cleanup="$6" lock="$7" author="$8" email="$9"',
  stepLine('git_auth'),
  'if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git >/dev/null 2>&1 || true; fi',
  gitIdentity('"$author"', '"$email"'),
  stepLine('clone'),
  'mkdir -p "$(dirname "$worktree")" "$(dirname "$lock")"',
  'exec 9>"$lock"',
  'flock 9',
  cleanupLoop,
  'if [ ! -d "$clone/.git" ]; then git clone "$repository" "$clone"; else',
  '  if [ "$(git -C "$clone" remote get-url origin)" != "$repository" ]; then echo "Another repository is already cloned at $clone" >&2; exit 1; fi',
  '  git -C "$clone" fetch --prune origin',
  'fi',
  'git -C "$clone" remote set-head origin --auto >/dev/null 2>&1 || true',
  stepLine('worktree'),
  'if [ ! -d "$worktree" ]; then',
  '  name="$wanted"; n=2',
  '  while git -C "$clone" show-ref --verify --quiet "refs/heads/$name" || git -C "$clone" ls-remote --exit-code --heads origin "$name" >/dev/null 2>&1; do name="$wanted-$n"; n=$((n + 1)); done',
  '  git -C "$clone" worktree add --no-track -b "$name" "$worktree" "origin/${base:-HEAD}"',
  'fi',
  'exec 9>&-',
  stepLine('toolchain'),
  'toolchain=0',
  `for file in ${toolchainFiles.join(' ')}; do if [ -f "$worktree/$file" ]; then toolchain=1; fi; done`,
  'if [ "$toolchain" = 1 ]; then (cd "$worktree" && mise trust --all && mise install --yes); fi',
].join('\n')

const cleanupScript = ['set -uo pipefail', 'cleanup="$1"', cleanupLoop].join('\n')

const cleanupLines = (entries: WorkspaceCleanup[]) =>
  entries.map((entry) => [entry.clone, entry.worktree, entry.branch].join('\t')).join('\n')

export const repositoryLock = (clone: string) => `${clone}.lock`

export const taskSetupCommand = (options: {
  repository: string
  clone: string
  worktree: string
  baseBranch: string | null
  branch: string
  cleanup: WorkspaceCleanup[]
  identity: GitIdentity | null
}) => [
  'bash',
  '-c',
  taskSetupScript,
  'task-setup',
  options.repository,
  options.clone,
  options.worktree,
  options.baseBranch ?? '',
  options.branch,
  cleanupLines(options.cleanup),
  repositoryLock(options.clone),
  options.identity?.name ?? '',
  options.identity?.email ?? '',
]

export const cleanupCommand = (entries: WorkspaceCleanup[]) => [
  'bash',
  '-c',
  cleanupScript,
  'task-cleanup',
  cleanupLines(entries),
]

export const machineSetupAs = (workspace: Pick<MachineWorkspace, 'kind'>) =>
  workspace.kind === 'project'
    ? {
        user: 'root',
        home: '/root',
        prefix: '/usr/local',
      }
    : {
        user: workspaceUser.name,
        home: workspaceUser.home,
        prefix: workspacePrefix,
      }

const asMemberScript = [
  'set -eu',
  'uid="$1" name="$2"',
  'shift 2',
  'if [ "${STATIONLY_MEMBER:-}" != "$name" ]; then echo "The run did not receive its member values" >&2; exit 1; fi',
  'if ! id -u "$name" >/dev/null 2>&1; then useradd -m -u "$uid" -s /bin/bash "$name" || id -u "$name" >/dev/null; fi',
  'chmod 700 "/home/$name"',
  'gid="$(id -g "$name")"',
  'exec setpriv --reuid="$uid" --regid="$gid" --init-groups env HOME="/home/$name" USER="$name" LOGNAME="$name" "$@"',
].join('\n')

export const asMember = (member: { uid: number; name: string }, command: string[]) => [
  'bash',
  '-c',
  asMemberScript,
  'as-member',
  String(member.uid),
  member.name,
  ...command,
]

export const repositoryName = (repository: string) =>
  repository
    .split('/')
    .at(-1)!
    .replace(/\.git$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

export const isRepositoryName = (name: string) => new RegExp(slugPattern).test(name)

export const workspacePath = (repository: string) =>
  `${workspaceRoot}/${repositoryName(repository)}`

export const setupCommand = (
  workspace: Pick<
    MachineWorkspace,
    'agent' | 'repository' | 'branch' | 'path' | 'task_branch' | 'kind'
  >,
  identity: GitIdentity | null = null,
) => [
  'bash',
  '-c',
  setupScript,
  'workspace-setup',
  workspaceAgents[workspace.agent].package,
  workspace.repository ?? '',
  workspace.path,
  workspace.branch ?? '',
  machineSetupAs(workspace).home,
  machineSetupAs(workspace).prefix,
  workspaceAgents[workspace.agent].config?.path ?? '',
  workspaceAgents[workspace.agent].config?.text ?? '',
  workspace.task_branch ?? '',
  identity?.name ?? '',
  identity?.email ?? '',
]

export const workspaceKeySets = (
  db: Db,
  context: { project: string; preview: string | null },
  agent: WorkspaceAgent,
  key: string,
  taken: string[],
  kind: TaskMachineValue = 'own',
): Static<typeof MachineKeySet>[] => {
  const shared = kind === 'own'
  const defined = new Set(
    keysOf(db, {
      scope: 'project',
      id: context.project,
    })
      .all()
      .map((v) => v.name),
  )

  return [
    ...(shared
      ? [
          {
            name: workspaceEnv.token,
            kind: 'sealed' as const,
            value: key,
          },
        ]
      : []),
    {
      name: workspaceEnv.apiUrl,
      kind: 'literal',
      value: workspaceApiUrl,
    },
    {
      name: workspaceEnv.project,
      kind: 'literal',
      value: context.project,
    },
    ...(context.preview
      ? [
          {
            name: workspaceEnv.preview,
            kind: 'literal' as const,
            value: context.preview,
          },
        ]
      : []),
    ...Object.entries(workspaceAgents[agent].env)
      .filter(([name]) => !taken.includes(name))
      .map(([name, value]) => ({
        name: name,
        kind: 'literal' as const,
        value,
      })),
    ...[...workspaceAgents[agent].keys, ...workspaceSharedKeys]
      .filter((name) => shared && defined.has(name) && !taken.includes(name))
      .map((name) => ({
        name: name,
        kind: 'reference' as const,
        reference: `\${{project.${name}}}`,
      })),
  ]
}

export const revokeWorkspaceToken = (
  db: Db,
  row: { workspace: MachineWorkspace | null },
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

  const tokenIds = [
    ...db
      .select({
        workspace: machine.workspace,
      })
      .from(machine)
      .where(isNotNull(machine.workspace))
      .all()
      .map((row) => row.workspace!.token_id),
    ...db
      .select({
        token_id: machine_user.token_id,
      })
      .from(machine_user)
      .where(isNotNull(machine_user.token_id))
      .all()
      .map((row) => row.token_id!),
  ]

  for (const tokenId of tokenIds) {
    const found = tokenRow(db, tokenId)

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

const shipScript = [
  'set -euo pipefail',
  'name="$1" worktree="$2" branch="$3" remote="$4" message="$5" author="$6" email="$7"',
  'gid="$(id -g "$name")"',
  'env -i HOME="/home/$name" PATH="$PATH" setpriv --reuid="$name" --regid="$gid" --init-groups sh -c \'cd "$1" && git add -A && { git diff --cached --quiet || git -c user.name="$3" -c user.email="$4" commit -q -m "$2"; }\' commit "$worktree" "$message" "$author" "$email"',
  'work="$(mktemp -d)"',
  'trap \'rm -rf "$work"\' EXIT',
  'git -c core.hooksPath=/dev/null clone -q --no-hardlinks --single-branch --branch "$branch" --upload-pack="git -c safe.directory=* upload-pack" "file://$worktree" "$work/repo"',
  'cd "$work/repo"',
  'git -c core.hooksPath=/dev/null -c credential.helper= -c credential.helper=\'!f() { echo username=x-access-token; echo "password=$GITHUB_PUSH_TOKEN"; }; f\' push -q "$remote" "+HEAD:refs/heads/$branch"',
  'git rev-parse HEAD',
].join('\n')

export const shipCommand = (options: {
  user: string
  worktree: string
  branch: string
  remote: string
  message: string
  identity: GitIdentity | null
}) => [
  'bash',
  '-c',
  shipScript,
  'task-ship',
  options.user,
  options.worktree,
  options.branch,
  options.remote,
  options.message,
  options.identity?.name ?? 'Stationly',
  options.identity?.email ?? 'stationly@localhost',
]
