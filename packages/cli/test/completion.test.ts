import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'

const entry = new URL('../src/index.ts', import.meta.url).pathname

const sly = (args: string[]) => promisify(execFile)(process.execPath, [entry, ...args])

const suggestions = async (...words: string[]) => {
  const { stdout } = await sly(['complete', '--', ...words])

  return stdout
    .trim()
    .split('\n')
    .filter((line) => !line.startsWith(':'))
    .map((line) => line.split('\t')[0])
}

test('sly completion prints a script for each shell that calls back into sly complete', async () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const { stdout } = await sly(['completion', shell])

    assert.match(stdout, /sly complete --/, shell)
  }

  assert.match((await sly(['completion', 'zsh'])).stdout, /^#compdef sly/)
})

test('an unknown shell is a usage error', async () => {
  await assert.rejects(sly(['completion', 'tcsh']), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 2)
    assert.match(error.stderr, /zsh, bash, fish, powershell/)

    return true
  })
})

test('the first word completes to every group and top-level command, generated or hand-written', async () => {
  const words = await suggestions('')

  for (const word of ['services', 'sandboxes', 'deploy', 'logs', 'login', 'push', 'completion']) {
    assert.ok(words.includes(word), word)
  }

  assert.ok(!words.includes('complete'))
  assert.deepEqual(await suggestions('sand'), ['sandboxes'])
})

test('a group completes to its subcommands with their summaries as hints', async () => {
  const { stdout } = await sly(['complete', '--', 'deployments', ''])

  assert.match(stdout, /^diagnosis\tThe diagnosis object of a failed deployment$/m)
  assert.match(stdout, /^wait\t/m)
  assert.ok((await suggestions('variables', 'ap')).includes('apply'))
})

test('flags complete after their command, also behind global flags, and global flags at the root', async () => {
  const flags = await suggestions('services', 'create', '--st')

  assert.ok(flags.includes('--strategy'))
  assert.ok(flags.includes('--station-id'))
  assert.ok((await suggestions('services', 'create', '--no-dep')).includes('--no-deploy-on-create'))
  assert.deepEqual(await suggestions('--service', 'web', 'logs', '--fol'), ['--follow'])
  assert.ok((await suggestions('--pro')).includes('--project'))
})

test('an enum flag completes to its choices', async () => {
  assert.deepEqual(await suggestions('services', 'create', '--kind', ''), [
    'web',
    'worker',
    'cron',
    'one_off',
  ])
  assert.deepEqual(await suggestions('logs', '--component', 'd'), ['depot'])
  assert.deepEqual(await suggestions('completion', ''), ['zsh', 'bash', 'fish', 'powershell'])
})
