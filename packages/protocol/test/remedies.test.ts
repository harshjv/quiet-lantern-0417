import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { remedyCatalog } from '../src/index.ts'

const root = join(import.meta.dirname, '..', '..', '..')

const sources = (dir: string, suffix: string, skip: string): string[] =>
  readdirSync(dir, {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((name) => name.endsWith(suffix) && !name.endsWith(skip))
    .map((name) => readFileSync(join(dir, name), 'utf8'))

const codes = (texts: string[], pattern: RegExp) =>
  [...new Set(texts.flatMap((text) => [...text.matchAll(pattern)].map((m) => m[1]!)))].sort()

test('every fix code stationd writes is in the remedy catalog', () => {
  const written = codes(
    sources(join(root, 'go'), '.go', '_test.go'),
    /Code:\s*"([A-Z][A-Z0-9_]*)",\s*Text:/g,
  )
  assert.ok(written.length > 0)
  assert.deepEqual(
    written.filter((code) => !(remedyCatalog as readonly string[]).includes(code)),
    [],
  )
})

test('Dispatch builds every fix through remedy()', () => {
  const literal = codes(
    sources(join(root, 'apps', 'dispatch', 'src'), '.ts', '.gen.ts'),
    /code:\s*'([A-Z][A-Z0-9_]*)',\s*text:/g,
  )
  assert.deepEqual(literal, [])
})
