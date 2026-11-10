import { fileURLToPath } from 'node:url'

import type { CommandUnknownOpts } from '@commander-js/extra-typings'

import { buildProgram } from './program.ts'

export const helpTreePath = fileURLToPath(new URL('../test/help-tree.txt', import.meta.url))

const usageOf = (command: CommandUnknownOpts) =>
  command.registeredArguments.map((a) => {
    const name = `${a.name()}${a.variadic ? '...' : ''}`
    return a.required ? `<${name}>` : `[${name}]`
  })

const summaryOf = (command: CommandUnknownOpts) =>
  (command.summary() || command.description()).split('\n')[0]

const lines = (command: CommandUnknownOpts, path: string[]): string[] =>
  [...command.commands]
    .sort((a, b) => a.name().localeCompare(b.name()))
    .flatMap((child) => {
      const words = [...path, child.name()]
      return [
        [...words, ...usageOf(child)].join(' '),
        `  ${summaryOf(child)}`,
        ...lines(child, words),
      ]
    })

export const helpTree = () => `${lines(buildProgram(), ['sly']).join('\n')}\n`
