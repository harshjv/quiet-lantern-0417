import { existsSync, readdirSync, readFileSync } from 'node:fs'

const sections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
const listed = (key: string) =>
  [
    ...(workspace.match(new RegExp(`^${key}:\\n((?:  .*\\n)+)`, 'm'))?.[1] ?? '').matchAll(
      /^ {2}-? ?'?([^':\n]+)'?/gm,
    ),
  ].map((m) => m[1]!.trim())
const catalog = new Set(listed('catalog'))
const dirs = listed('packages').flatMap((pattern) =>
  pattern.endsWith('/*')
    ? readdirSync(pattern.slice(0, -2)).map((name) => `${pattern.slice(0, -2)}/${name}`)
    : [pattern],
)
const manifests = ['package.json', ...dirs.map((dir) => `${dir}/package.json`).filter(existsSync)]

const uses = new Map<string, { file: string; spec: string }[]>()

for (const file of manifests) {
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Partial<
    Record<(typeof sections)[number], Record<string, string>>
  >

  for (const section of sections) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (!spec.startsWith('workspace:')) {
        uses.set(name, [
          ...(uses.get(name) ?? []),
          {
            file,
            spec,
          },
        ])
      }
    }
  }
}

const problems = [
  ...[...uses]
    .filter(([name, list]) => list.length > 1 && !catalog.has(name))
    .map(
      ([name, list]) =>
        `${name} is used by ${list.map((u) => u.file).join(', ')}; add it to the catalog in pnpm-workspace.yaml`,
    ),
  ...[...uses].flatMap(([name, list]) =>
    catalog.has(name)
      ? list
          .filter((u) => u.spec !== 'catalog:')
          .map((u) => `${u.file} pins ${name} to ${u.spec}; use "catalog:"`)
      : [],
  ),
  ...[...catalog]
    .filter((name) => !uses.has(name))
    .map((name) => `${name} is in the catalog but no package uses it`),
]

if (problems.length) {
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`)
  }

  process.exit(1)
}
