import ky, { isHTTPError, isNetworkError, isTimeoutError, type RetryOptions } from 'ky'

export const userAgent = 'stationly-dispatch'

export const http = ky.create({
  headers: {
    'user-agent': userAgent,
  },
  timeout: 15_000,
  retry: 0,
})

export const transientRetry: RetryOptions = {
  limit: 2,
  statusCodes: [500, 502, 503, 504],
  backoffLimit: 2_000,
  maxRetryAfter: 5_000,
}

export const failureOf = (error: unknown) => {
  if (isHTTPError(error)) {
    return `HTTP ${error.response.status}`
  }

  if (isTimeoutError(error)) {
    return 'timed out'
  }

  const reasons: string[] = []

  for (let e = isNetworkError(error) ? error.cause : error; e instanceof Error; e = e.cause) {
    reasons.push(e.message)
  }

  return reasons.join(': ') || String(error)
}
