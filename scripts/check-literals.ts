import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { slugPattern, variableKeyPattern } from '../packages/protocol/src/domain.ts'
import { defaultRegistryAddress, networkLayout } from '../packages/protocol/src/network.ts'
import { resourcePrefix, tokenPrefix } from '../packages/protocol/src/primitives.ts'
import { releaseConfig } from '../packages/protocol/src/release-config.ts'
import { rootSocketPath, stationdUnit } from '../packages/protocol/src/root-socket.ts'

type Constant = { name: string; home: string; pattern: RegExp }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const literal = (value: string) => new RegExp(escape(value))
const word = (value: string | number) => new RegExp(`(?<![\\w.])${escape(String(value))}(?!\\w)`)
const builder = (prefix: string) => new RegExp(`["'\`]${escape(prefix)}`)
const imageSource = (source: string) => {
  const path = source.slice(source.indexOf('/') + 1)
  return new RegExp(
    path.includes('/')
      ? `${escape(source)}|(?<![\\w./-])${escape(path)}(?![\\w-])`
      : escape(source),
  )
}
const regexSource = (pattern: string) =>
  new RegExp(escape(pattern.slice(1, -1)).replaceAll('-', '\\\\{0,2}-'))

const releaseHome = 'release.config.json'
const images = {
  ...releaseConfig.components,
  ...Object.fromEntries(
    Object.entries(releaseConfig.acceptance_images).map(([name, ref]) => [
      name,
      {
        digest: ref.slice(ref.indexOf('@') + 1),
      },
    ]),
  ),
}

const constants: Constant[] = [
  {
    name: 'GHCR namespace',
    home: releaseHome,
    pattern: literal(releaseConfig.registry_namespace),
  },
  {
    name: 'installer URL',
    home: releaseHome,
    pattern: literal(new URL(releaseConfig.installer_url).host),
  },
  {
    name: 'signing source repository',
    home: releaseHome,
    pattern: literal(new URL(releaseConfig.signing_identity.source_repository).pathname.slice(1)),
  },
  {
    name: 'signing source repository id',
    home: releaseHome,
    pattern: word(releaseConfig.signing_identity.source_repository_id),
  },
  {
    name: 'signing source repository owner id',
    home: releaseHome,
    pattern: word(releaseConfig.signing_identity.source_repository_owner_id),
  },
  {
    name: 'TUF mirror',
    home: releaseHome,
    pattern: literal(new URL(releaseConfig.tuf_mirror).host),
  },
  ...Object.entries(releaseConfig.media_types).map(([name, value]) => ({
    name: `${name} media type`,
    home: releaseHome,
    pattern: literal(value),
  })),
  ...Object.entries(releaseConfig.components).map(([name, { source }]) => ({
    name: `${name} image source`,
    home: releaseHome,
    pattern: imageSource(source),
  })),
  ...Object.entries(images).map(([name, { digest }]) => ({
    name: `${name} image digest`,
    home: releaseHome,
    pattern: literal(digest.replace(/^sha256:/, '')),
  })),
  {
    name: 'resource prefix',
    home: 'packages/protocol/src/primitives.ts',
    pattern: builder(resourcePrefix),
  },
  {
    name: 'token prefix',
    home: 'packages/protocol/src/primitives.ts',
    pattern: builder(tokenPrefix),
  },
  {
    name: 'slug pattern',
    home: 'packages/protocol/src/domain.ts',
    pattern: regexSource(slugPattern),
  },
  {
    name: 'variable key pattern',
    home: 'packages/protocol/src/domain.ts',
    pattern: regexSource(variableKeyPattern),
  },
  {
    name: 'Dispatch port',
    home: 'packages/protocol/src/network.ts',
    pattern: word(networkLayout.dispatchPort),
  },
  {
    name: 'default pool',
    home: 'packages/protocol/src/network.ts',
    pattern: literal(networkLayout.defaultPool),
  },
  {
    name: 'default virtual prefix',
    home: 'packages/protocol/src/network.ts',
    pattern: literal(networkLayout.defaultVirtualPrefix),
  },
  {
    name: 'registry address',
    home: 'packages/protocol/src/network.ts',
    pattern: literal(defaultRegistryAddress),
  },
  {
    name: 'root socket path',
    home: 'packages/protocol/src/root-socket.ts',
    pattern: literal(rootSocketPath),
  },
  {
    name: 'stationd unit',
    home: 'packages/protocol/src/root-socket.ts',
    pattern: word(stationdUnit),
  },
]

const exceptions: { file: string; constant: string; reason: string }[] = [
  {
    file: '.gitleaks.toml',
    constant: 'resource prefix',
    reason: 'gitleaks reads its rules from TOML and cannot import the recovery key prefix',
  },
  {
    file: '.gitleaks.toml',
    constant: 'token prefix',
    reason: 'gitleaks reads its rules from TOML and cannot import the token prefix',
  },
  {
    file: 'go/cmd/stationd/main.go',
    constant: 'resource prefix',
    reason: 'the sly-path flag is named after the sly CLI, not a host resource',
  },
  {
    file: 'packages/cli/scripts/sea.ts',
    constant: 'resource prefix',
    reason: 'the standalone binaries are named after the sly CLI, not a host resource',
  },
  {
    file: 'installer/acceptance/lib/box.sh',
    constant: 'resource prefix',
    reason: 'Hetzner box names for acceptance runs are not host resources',
  },
  {
    file: 'installer/acceptance/rows/35-sandboxes.sh',
    constant: 'token prefix',
    reason: 'sly_run is the acceptance helper that runs sly, not a token',
  },
  {
    file: 'installer/test-release/testsign/signcmd.go',
    constant: 'sigstore_bundle media type',
    reason: 'the test signer is its own Go module and cannot import go/internal/protocol',
  },
]

const skipped = [
  /^(\.scratchpad|docs|guide|public|packages\/protocol\/schema)\//,
  /(^|\/)(testdata|fixtures|test)\//,
  /(_test\.go|\.test\.tsx?)$/,
  /^packages\/manifest-schema\/schema\//,
  /(_gen\.go|\.gen\.\w+)$/,
  /(^|\/)(pnpm-lock\.yaml|go\.sum)$/,
  /\.(png|jpe?g|gif|ico|svg|woff2?|webp|pdf|tar|gz|zip)$/,
  /^scripts\/check-literals\.ts$/,
]

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((file) => file && !skipped.some((pattern) => pattern.test(file)))

const excepted = (file: string, constant: Constant) =>
  exceptions.some((e) => e.file === file && e.constant === constant.name)

const problems: string[] = []
for (const file of files) {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const candidates = constants.filter(
    (constant) =>
      constant.home !== file && !excepted(file, constant) && constant.pattern.test(text),
  )
  if (!candidates.length) continue
  text.split('\n').forEach((line, index) => {
    for (const constant of candidates)
      if (constant.pattern.test(line))
        problems.push(`${file}:${index + 1}: ${constant.name} belongs in ${constant.home}`)
  })
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  process.exit(1)
}
