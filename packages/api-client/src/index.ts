import { treaty } from '@elysia/eden'

import type { App } from '@stationly/dispatch'

export const createApiClient = (baseUrl: string, fetcher?: typeof fetch) =>
  treaty<App>(baseUrl, {
    fetcher,
    parseDate: false,
  })

export type ApiClient = ReturnType<typeof createApiClient>

export type { Treaty } from '@elysia/eden'
