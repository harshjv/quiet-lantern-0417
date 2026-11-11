import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { HTTPError, NetworkError, TimeoutError } from 'ky'

import { openDb } from '../src/db/client.ts'
import type { notification_channel } from '../src/db/schema.ts'
import { gh, GitHubError } from '../src/github/client.ts'
import { failureOf } from '../src/net/http.ts'
import { post, sealSecret } from '../src/notify/webhooks.ts'
import { Keyring } from '../src/secrets/keyring.ts'

const dir = mkdtempSync(join(tmpdir(), 'sly-outbound-'))

after(() =>
  rmSync(dir, {
    recursive: true,
    force: true,
  }),
)

const serve = async (handler: RequestListener) => {
  const server = createServer(handler)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  after(() => server.close())

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const counting = (status: number, body = '') => {
  const seen = {
    requests: 0,
  }
  const handler: RequestListener = (_req, res) => {
    seen.requests++
    res.writeHead(status, {
      'content-type': 'application/json',
    })
    res.end(body)
  }

  return {
    seen,
    handler,
  }
}

describe('webhook delivery', () => {
  const keyring = new Keyring(openDb(join(dir, 'webhooks.sqlite')), randomBytes(32))
  const channelTo = (url: string) =>
    ({
      id: 'nch_test',
      kind: 'webhook',
      config: {
        url,
        secret: sealSecret(keyring, 'nch_test', 'shh'),
      },
    }) as unknown as typeof notification_channel.$inferSelect

  test('a 503 is one attempt; the retry ladder in the database owns the next one', async () => {
    const { seen, handler } = counting(503)
    const url = await serve(handler)
    const result = await post(keyring, channelTo(url), 'test', 'evt.nch', '{}')

    assert.equal(seen.requests, 1)
    assert.equal(result.ok, false)
    assert.equal(result.status_code, 503)
    assert.equal(result.error, 'HTTP 503')
  })

  test('a dropped connection is one attempt and names the cause', async () => {
    const seen = {
      requests: 0,
    }
    const url = await serve((req) => {
      seen.requests++
      req.socket.destroy()
    })
    const result = await post(keyring, channelTo(url), 'test', 'evt.nch', '{}')

    assert.equal(seen.requests, 1)
    assert.equal(result.status_code, null)
    assert.match(result.error, /fetch failed/)
  })
})

describe('GitHub client', () => {
  test('an error status becomes a GitHubError with the API message', async () => {
    const { handler } = counting(
      404,
      JSON.stringify({
        message: 'Not Found',
      }),
    )

    process.env.STATIONLY_GITHUB_API_URL = await serve(handler)

    await assert.rejects(
      gh('/repos/acme/web?per_page=1'),
      (error: unknown) =>
        error instanceof GitHubError &&
        error.status === 404 &&
        error.message === 'GitHub GET /repos/acme/web?per_page=1 answered 404: Not Found',
    )
  })

  test('a 503 on a read is retried twice before it fails', async () => {
    const { seen, handler } = counting(503)

    process.env.STATIONLY_GITHUB_API_URL = await serve(handler)

    await assert.rejects(
      gh('/rate_limit'),
      (error: unknown) => error instanceof GitHubError && error.status === 503,
    )
    assert.equal(seen.requests, 3)
  })
})

describe('failureOf', () => {
  const request = new Request('http://127.0.0.1/x')

  test('names the status of an HTTP error', () => {
    assert.equal(
      failureOf(
        new HTTPError(
          new Response(null, {
            status: 502,
          }),
          request,
          {} as never,
        ),
      ),
      'HTTP 502',
    )
  })

  test('names a timeout without the URL', () => {
    assert.equal(failureOf(new TimeoutError(request)), 'timed out')
  })

  test('walks the cause chain of a network error', () => {
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:1')
    const failed = new TypeError('fetch failed', {
      cause: refused,
    })

    assert.equal(
      failureOf(
        new NetworkError(request, {
          cause: failed,
        }),
      ),
      'fetch failed: connect ECONNREFUSED 127.0.0.1:1',
    )
  })
})
