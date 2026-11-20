import type { OpenApiDocument } from '@stationly/mcp'

import { openApiDocument } from './openapi.gen.ts'

const groups: Record<string, string> = {
  'environment-variables': 'env',
}

export const groupOf = (tag: string) => groups[tag] ?? tag

export const tagSummary = (group: string, document: OpenApiDocument = openApiDocument) =>
  document.tags?.find((t) => groupOf(t.name) === group)?.description ?? group
