import { existsSync, readFileSync } from 'node:fs'

const docsDir = new URL('../../../../docs/', import.meta.url)

export const readDoc = (file: string) => readFileSync(new URL(file, docsDir), 'utf8')

export const docsSkip = !existsSync(docsDir) && 'docs live in the private repository'
