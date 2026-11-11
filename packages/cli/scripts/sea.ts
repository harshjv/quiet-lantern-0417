import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Command, Option } from '@commander-js/extra-typings'
import { build } from 'rolldown'

const targets = {
  'linux-amd64': ['linux', 'x64'],
  'linux-arm64': ['linux', 'arm64'],
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-amd64': ['darwin', 'x64'],
} as const

type Target = keyof typeof targets

const values = new Command('sea')
  .description('Build the sly single executable for each target')
  .requiredOption('--version <version>', 'the version to embed')
  .requiredOption('--out <dir>', 'where the binaries go')
  .option('--cache <dir>', 'download and build cache (default <out>/.cache)')
  .addOption(
    new Option('--targets <list>', 'comma-separated targets').default(
      Object.keys(targets).join(','),
    ),
  )
  .parse()
  .opts()

const fail = (message: string): never => {
  process.stderr.write(`sea: ${message}\n`)
  process.exit(2)
}

const wanted = values.targets.split(',').map((t) => t.trim()) as Target[]

for (const t of wanted) {
  if (!(t in targets)) {
    fail(`unknown target ${t}`)
  }
}

if (wanted.some((t) => t.startsWith('darwin-')) && process.platform !== 'darwin') {
  fail('darwin targets need ad-hoc codesigning with codesign, so build them on macOS')
}

const out = resolve(values.out)
const cache = resolve(values.cache ?? join(out, '.cache'))
const work = join(cache, 'work')

mkdirSync(cache, {
  recursive: true,
})
mkdirSync(work, {
  recursive: true,
})

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 2, 'inherit'],
  })

  if (r.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}`)
  }
}

const node = process.versions.node
const dist = `https://nodejs.org/dist/v${node}`

const download = async (url: string) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(300_000),
  })

  if (res.status !== 200) {
    fail(`GET ${url} answered ${res.status}`)
  }

  return Buffer.from(await res.arrayBuffer())
}

const shasumsPath = join(cache, `SHASUMS256-v${node}.txt`)

if (!existsSync(shasumsPath)) {
  writeFileSync(shasumsPath, await download(`${dist}/SHASUMS256.txt`))
}

const shasums = new Map(
  readFileSync(shasumsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/).reverse() as [string, string]),
)

const nodeBinary = async (os: string, arch: string) => {
  const name = `node-v${node}-${os}-${arch}`
  const tarball = join(cache, `${name}.tar.gz`)
  const want =
    shasums.get(`${name}.tar.gz`) ?? fail(`${dist}/SHASUMS256.txt lists no ${name}.tar.gz`)

  if (!existsSync(tarball) || sha256(readFileSync(tarball)) !== want) {
    writeFileSync(tarball, await download(`${dist}/${name}.tar.gz`))
  }

  if (sha256(readFileSync(tarball)) !== want) {
    fail(`${name}.tar.gz does not match ${dist}/SHASUMS256.txt`)
  }

  const dir = join(cache, name)

  if (!existsSync(join(dir, 'bin', 'node'))) {
    run('tar', ['-xzf', tarball, '-C', cache, `${name}/bin/node`])
  }

  return join(dir, 'bin', 'node')
}

const bundle = join(work, 'sly.mjs')

await build({
  input: resolve(import.meta.dirname, '../src/index.ts'),
  platform: 'node',
  logLevel: 'warn',
  transform: {
    define: {
      'process.env.STATIONLY_BUILD_VERSION': JSON.stringify(values.version),
    },
  },
  output: {
    file: bundle,
    format: 'esm',
    codeSplitting: false,
  },
})

const result: Record<string, string> = {}

for (const target of wanted) {
  const [os, arch] = targets[target]
  const output = join(out, `sly-${target}`)

  rmSync(output, {
    force: true,
  })
  const config = join(work, `sea-${target}.json`)

  writeFileSync(
    config,
    JSON.stringify({
      main: bundle,
      mainFormat: 'module',
      executable: await nodeBinary(os, arch),
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    }),
  )
  run(process.execPath, ['--build-sea', config])

  if (os === 'darwin') {
    run('codesign', ['--force', '--sign', '-', output])
  }

  chmodSync(output, 0o755)
  result[target] = `sha256:${sha256(readFileSync(output))}`
}

rmSync(work, {
  recursive: true,
  force: true,
})
process.stdout.write(
  `${JSON.stringify({
    version: values.version,
    node,
    platforms: result,
  })}\n`,
)
