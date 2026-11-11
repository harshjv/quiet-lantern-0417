import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { workspaceEnv } from '@stationly/protocol'

import { setupCommand, workspaceVariableSets } from '../src/sandboxes/workspace.ts'

import { startDispatch, type Dispatch } from './helpers/dispatch.ts'

let h: Dispatch
let scratch: string
let bin: string
let log: string

const workspace = (path: string) => ({
  agent: 'claude' as const,
  repository: 'https://github.com/acme/app',
  branch: null,
  path,
})

const stub = (name: string, body: string) => {
  const file = join(bin, name)

  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
}

const runSetup = (repo: string) => {
  writeFileSync(log, '')
  execFileSync(
    'bash',
    setupCommand(workspace(repo))
      .slice(1)
      .map((arg) => arg.replace('/home/agent', scratch)),
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: scratch,
      },
    },
  )

  return readFileSync(log, 'utf8')
}

before(async () => {
  h = await startDispatch()
  scratch = mkdtempSync(join(tmpdir(), 'workspace-setup-'))
  bin = join(scratch, 'bin')
  log = join(scratch, 'calls')
  mkdirSync(bin)

  for (const name of ['npm', 'gh', 'git', 'mise']) {
    stub(name, `echo "${name} $PWD $*" >>"${log}"`)
  }
})

after(async () => {
  rmSync(scratch, {
    recursive: true,
    force: true,
  })
  await h.close()
})

describe('workspace setup', () => {
  for (const file of [
    'mise.toml',
    '.mise.toml',
    '.config/mise.toml',
    'mise.local.toml',
    '.tool-versions',
  ]) {
    test(`trusts and installs the repository toolchain when it has ${file}`, () => {
      const repo = join(scratch, `with-${file.replaceAll('/', '-')}`)

      mkdirSync(join(repo, '.git'), {
        recursive: true,
      })
      mkdirSync(dirname(join(repo, file)), {
        recursive: true,
      })
      writeFileSync(join(repo, file), '[tools]\nnode = "26"\n')
      const calls = runSetup(repo)

      assert.match(calls, new RegExp(`mise ${repo} trust --all`))
      assert.match(calls, new RegExp(`mise ${repo} install --yes`))
      assert.ok(calls.indexOf('trust --all') < calls.indexOf('install --yes'))
    })
  }

  test('runs no mise install when the repository declares no toolchain', () => {
    const repo = join(scratch, 'without')

    mkdirSync(join(repo, '.git'), {
      recursive: true,
    })

    assert.doesNotMatch(runSetup(repo), /mise/)
  })

  test('writes nothing into the repository', () => {
    const repo = join(scratch, 'clean')

    mkdirSync(join(repo, '.git'), {
      recursive: true,
    })
    runSetup(repo)

    assert.deepEqual(execFileSync('ls', ['-A', repo]).toString().trim().split('\n'), ['.git'])
  })
})

test('a workspace receives its project and environment as literal variables', () => {
  const sets = workspaceVariableSets(
    h.db,
    {
      project: 'prj_one',
      environment: 'env_one',
    },
    'claude',
    'key',
    [],
  )

  assert.deepEqual(
    sets.filter((set) =>
      [workspaceEnv.project, workspaceEnv.environment].includes(set.key as never),
    ),
    [
      {
        key: 'STATIONLY_PROJECT',
        kind: 'literal',
        value: 'prj_one',
      },
      {
        key: 'STATIONLY_ENVIRONMENT',
        kind: 'literal',
        value: 'env_one',
      },
    ],
  )
})
