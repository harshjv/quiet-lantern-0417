import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { Command } from 'commander'

import { breakingChanges, type Snapshot } from '../packages/protocol/scripts/compat.ts'

type Accepted = { at: string; reason: string }

const schemaDir = 'packages/protocol/schema'
const acceptedFile = 'packages/protocol/breaking.json'
const files = {
  protocol: 'protocol.json',
  messages: 'messages.json',
  errors: 'errors.json',
}

const git = (args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

const attempt = <T>(read: () => T) => {
  try {
    return read()
  } catch {
    return undefined
  }
}

const snapshot = (read: (file: string) => string) =>
  Object.fromEntries(
    Object.entries(files).map(([key, file]) => [key, JSON.parse(read(`${schemaDir}/${file}`))]),
  ) as Snapshot

const options = new Command('check-compat')
  .description('Compare the generated protocol schema with the latest stable release')
  .option('--base <ref>', 'baseline git ref (default: the nearest stable v* tag)')
  .parse()
  .opts<{ base?: string }>()
const base =
  options.base ??
  process.env.STATIONLY_COMPAT_BASE ??
  attempt(() => git(['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', '*-*']))

if (!base) {
  process.stdout.write(
    'no stable v* tag is reachable, so there is no baseline protocol to compare\n',
  )
  process.exit(0)
}

if (!attempt(() => git(['rev-parse', '--verify', `${base}^{commit}`]))) {
  process.stderr.write(`${base} is not a commit in this clone\n`)
  process.exit(1)
}

const baseline = attempt(() => snapshot((path) => git(['show', `${base}:${path}`])))

if (!baseline) {
  process.stdout.write(`${base} has no generated protocol schema to compare against\n`)
  process.exit(0)
}

const accepted = JSON.parse(readFileSync(acceptedFile, 'utf8')) as Accepted[]
const breaks = breakingChanges(
  baseline,
  snapshot((path) => readFileSync(path, 'utf8')),
)
const declared = new Set(accepted.map((entry) => entry.at))

const problems = [
  ...accepted
    .filter((entry) => !entry.reason?.trim())
    .map((entry) => `${acceptedFile}: ${entry.at} needs a reason`),
  ...breaks.filter((item) => !declared.has(item.at)).map((item) => `${item.at}: ${item.change}`),
]

for (const entry of accepted.filter((entry) => !breaks.some((item) => item.at === entry.at))) {
  process.stdout.write(`${acceptedFile}: ${entry.at} is not a break against ${base}\n`)
}

if (problems.length) {
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`)
  }

  process.stderr.write(
    `breaking protocol changes against ${base}; declare deliberate ones in ${acceptedFile} with a reason\n`,
  )
  process.exit(1)
}

process.stdout.write(`protocol is compatible with ${base}\n`)
