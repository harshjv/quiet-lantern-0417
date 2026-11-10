import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { OpenApiDocument } from '@stationly/mcp'

import { generatedCommands } from '../../../packages/cli/src/generated.ts'
import { handWrittenProgram } from '../../../packages/cli/src/program.ts'

import { startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { docsSkip, readDoc } from './helpers/docs.ts'

const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

let h: Dispatch

before(async () => {
  h = await startDispatch()
})

after(async () => {
  await h.close()
})

test('every /v1 operation declares an operationId and x-stationly.level, and no two operations share an operationId', async () => {
  const doc = (
    await h.call('GET', '/openapi/json', {
      token: h.admin.token,
    })
  ).body
  const owners = new Map<string, string>()
  const problems: string[] = []
  for (const [path, item] of Object.entries<
    Record<string, { operationId?: string; 'x-stationly'?: { level?: string } }>
  >(doc.paths)) {
    for (const method of methods) {
      const operation = item[method]
      if (!operation) continue
      const where = `${method.toUpperCase()} ${path}`
      if (path.startsWith('/v1') && !operation.operationId)
        problems.push(`${where} has no operationId`)
      if (path.startsWith('/v1') && !operation['x-stationly']?.level)
        problems.push(`${where} has no x-stationly.level`)
      if (!operation.operationId) continue
      const owner = owners.get(operation.operationId)
      if (owner) problems.push(`${where} and ${owner} share operationId ${operation.operationId}`)
      else owners.set(operation.operationId, where)
    }
  }
  assert.ok(owners.size >= 100, `only ${owners.size} operations carry an operationId`)
  assert.deepEqual(problems, [])
})

const docLevels: Record<string, string> = {
  public: 'public',
  any: 'any credential',
  read: 'read',
  deploy: 'deploy',
  admin: 'admin',
  'instance read': 'instance read',
  'instance admin': 'instance admin',
}

const catalogRows = (file: string) => {
  const rows: { file: string; key: string; level: string | null; tool: string; sly: string }[] = []
  let columns: string[] | null = null
  for (const line of readDoc(file).split('\n')) {
    if (!line.startsWith('|')) {
      columns = null
      continue
    }
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^-+$/.test(cell))) continue
    if (!columns) {
      columns = ['Method', 'Path', 'Level', 'Tool', 'sly'].every((name) => cells.includes(name))
        ? cells
        : []
      continue
    }
    if (!columns.length) continue
    const at = (name: string) => cells[columns!.indexOf(name)] ?? ''
    const path = /`([^`]+)`/.exec(at('Path'))?.[1]
    if (!path) continue
    const level = /^(?:`([^`]+)`|(any credential|public))/.exec(at('Level'))
    rows.push({
      file,
      key: `${at('Method')} ${path.replace(/\{[^}]+\}/g, '{}')}`,
      level: level ? (level[1] ?? level[2]!) : null,
      tool: at('Tool'),
      sly: at('sly'),
    })
  }
  return rows
}

type Tree = { name: () => string; commands: readonly Tree[] }

const handWritten = (command: Tree, path: string[] = []): string[] =>
  command.commands.flatMap((child) => [
    [...path, child.name()].join(' '),
    ...handWritten(child, [...path, child.name()]),
  ])

test(
  'every route has one row in 22-rest-endpoints.md or 24-sandboxes.md, and its Level, Tool and sly columns match the route',
  {
    skip: docsSkip,
  },
  async () => {
    const doc = (
      await h.call('GET', '/openapi/json', {
        token: h.admin.token,
      })
    ).body
    const rows = [...catalogRows('22-rest-endpoints.md'), ...catalogRows('24-sandboxes.md')]
    const commands = new Map(
      generatedCommands(doc as OpenApiDocument).map((g) => [g.endpoint.name, g.path.join(' ')]),
    )
    const written = new Set(handWritten(handWrittenProgram()))
    const problems: string[] = []
    for (const [path, item] of Object.entries<
      Record<
        string,
        {
          operationId?: string
          'x-stationly'?: { level: string; mcp?: false | object; cli?: false | object }
        }
      >
    >(doc.paths)) {
      for (const method of methods) {
        const operation = item[method]
        if (!operation?.operationId || !operation['x-stationly']) continue
        const key = `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`
        const matching = rows.filter((row) => row.key === key)
        if (matching.length !== 1) {
          problems.push(`${key} (${operation.operationId}) has ${matching.length} rows`)
          continue
        }
        const row = matching[0]!
        const meta = operation['x-stationly']
        const level = docLevels[meta.level]
        if (row.level !== level)
          problems.push(`${row.file} ${key}: Level ${row.level} but the route declares ${level}`)
        const tool =
          meta.mcp === false
            ? /^none\b/.test(row.tool)
            : row.tool === `\`${operation.operationId}\``
        if (!tool)
          problems.push(
            `${row.file} ${key}: Tool ${row.tool} but the route is ${meta.mcp === false ? 'mcp false' : operation.operationId}`,
          )
        const command = /^`sly ([^`]+)`$/.exec(row.sly)?.[1]
        const sly =
          meta.cli === false
            ? command !== undefined && written.has(command)
            : command === commands.get(operation.operationId)
        if (!sly)
          problems.push(
            `${row.file} ${key}: sly ${row.sly} but the route's command is ${meta.cli === false ? 'hand-written' : `sly ${commands.get(operation.operationId)}`}`,
          )
      }
    }
    assert.deepEqual(problems, [])
  },
)
