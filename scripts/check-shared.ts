import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { sharedComputations, sharedTestdataDir } from '../packages/protocol/src/shared.ts'

const testSuffix = {
  goTest: '_test.go',
  tsTest: '.test.ts',
} as const

const readerText = (file: string) => {
  const text = readFileSync(file, 'utf8')
  const imported = [...text.matchAll(/from '(\.\.?\/[^']+)'/g)]
    .map((m) => join(dirname(file), m[1]!))
    .filter(existsSync)

  return [text, ...imported.map((path) => readFileSync(path, 'utf8'))].join('\n')
}

const registered = new Set(sharedComputations.flatMap((entry) => entry.vectors))

const problems = [
  ...sharedComputations.flatMap(({ id, vectors, ...tests }) => [
    ...vectors
      .filter((name) => !existsSync(join(sharedTestdataDir, name)))
      .map((name) => `${id}: ${sharedTestdataDir}/${name} does not exist`),
    ...Object.entries(tests).flatMap(([side, file]) => {
      const suffix = testSuffix[side as keyof typeof testSuffix]

      if (!file.endsWith(suffix)) {
        return [`${id}: ${side} ${file} is not a ${suffix} file`]
      }

      if (!existsSync(file)) {
        return [`${id}: ${side} ${file} does not exist`]
      }

      const text = readerText(file)

      return vectors
        .filter((name) => !text.includes(name))
        .map((name) => `${id}: ${file} does not read ${name}`)
    }),
  ]),
  ...readdirSync(sharedTestdataDir)
    .filter((name) => name.endsWith('.json') && !registered.has(name))
    .map(
      (name) =>
        `${sharedTestdataDir}/${name} is not in packages/protocol/src/shared.ts; register the computation it pins`,
    ),
]

if (problems.length) {
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`)
  }

  process.exit(1)
}
