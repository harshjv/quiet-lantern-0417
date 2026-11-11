import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: { prepare: string }
}

const scratch = () => mkdtempSync(join(tmpdir(), 'hooks-'))

test('prepare points core.hooksPath at the checked-in hooks', () => {
  const repo = scratch()

  execFileSync('git', ['init', '--quiet'], {
    cwd: repo,
  })
  execFileSync('sh', ['-c', manifest.scripts.prepare], {
    cwd: repo,
  })

  const hooksPath = execFileSync('git', ['config', 'core.hooksPath'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()

  assert.equal(hooksPath, '.githooks')
})

test('prepare succeeds outside a git work tree', () => {
  execFileSync('sh', ['-c', manifest.scripts.prepare], {
    cwd: scratch(),
  })
})

test('prepare succeeds where git is not installed', () => {
  execFileSync('/bin/sh', ['-c', manifest.scripts.prepare], {
    cwd: scratch(),
    env: {
      PATH: scratch(),
    },
  })
})

const runHook = (failing: string | null) => {
  const bin = scratch()
  const log = join(bin, 'calls.log')

  writeFileSync(
    join(bin, 'mise'),
    `#!/usr/bin/env sh\necho "$*" >>"${log}"\n${failing ? `case "$*" in *${failing}*) exit 1;; esac` : ''}\n`,
  )
  chmodSync(join(bin, 'mise'), 0o755)

  const result = spawnSync('sh', [join(root, '.githooks', 'pre-commit')], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    },
  })

  return {
    status: result.status,
    calls: readFileSync(log, 'utf8').trim().split('\n'),
  }
}

test('the pre-commit hook runs gitleaks and then check:literals', () => {
  const { status, calls } = runHook(null)

  assert.equal(status, 0)
  assert.equal(calls.length, 2)
  assert.match(calls[0]!, /^exec -- gitleaks git --pre-commit --staged/)
  assert.equal(calls[1], 'exec -- pnpm check:literals')
})

test('the pre-commit hook fails when check:literals fails', () => {
  const { status } = runHook('check:literals')

  assert.notEqual(status, 0)
})

test('the pre-commit hook stops at a gitleaks finding', () => {
  const { status, calls } = runHook('gitleaks')

  assert.notEqual(status, 0)
  assert.equal(calls.length, 1)
})
