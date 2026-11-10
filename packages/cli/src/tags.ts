import type { OpenApiDocument } from '@stationly/mcp'

import { openApiDocument } from './openapi.gen.ts'

export const tagSummary = (tag: string, document: OpenApiDocument = openApiDocument) =>
  document.tags?.find((t) => t.name === tag)?.description ?? tag
