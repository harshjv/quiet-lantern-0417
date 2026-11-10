import { treaty } from '@elysia/eden'

import type { App } from '@stationly/dispatch'

export type ApiClientOptions = {
  token?: string
  userAgent?: string
  fetcher?: typeof fetch
}

export const createApiClient = (baseUrl: string, options: ApiClientOptions = {}) =>
  treaty<App>(baseUrl, {
    headers: {
      ...(options.token
        ? {
            authorization: `Bearer ${options.token}`,
          }
        : {}),
      ...(options.userAgent
        ? {
            'user-agent': options.userAgent,
          }
        : {}),
    },
    ...(options.fetcher
      ? {
          fetcher: options.fetcher,
        }
      : {}),
    parseDate: false,
  })

export type ApiClient = ReturnType<typeof createApiClient>

export type { Treaty } from '@elysia/eden'
