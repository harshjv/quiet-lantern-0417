import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaBaseUrl } from '@stationly/protocol'
import { Manifest } from '../src/schema.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaDir = join(packageRoot, 'schema')

const { title, ...rest } = JSON.parse(JSON.stringify(Manifest)) as Record<string, unknown>
const document = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `${schemaBaseUrl}manifest/v1/manifest.schema.json`,
  title,
  ...rest
}

mkdirSync(schemaDir, { recursive: true })
writeFileSync(join(schemaDir, 'manifest.schema.json'), `${JSON.stringify(document, null, 2)}\n`)
