import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { agentEventLimits } from '@stationly/protocol'

import { agent_event, event, sandbox } from '../src/db/schema.ts'
import { writeSetting } from '../src/db/settings.ts'
import {
  enforceAgentCaps,
  ingestAgentEvents,
  sweepAgentEvents,
} from '../src/sandboxes/agent-events.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { createProject, createSandbox, pinPlatform, rows, waitForSandbox } from './helpers/seed.ts'

let h: Dispatch
let project: any
let envId: string
let workspaceId: string
let plainId: string
let workspaceKey: string
let workspaceTokenId: string
let clock = Date.parse('2026-11-12T10:00:00.000Z')

const sealed = 'sealed-value-0123456789abcdef'

const api = (method: string, path: string, body?: unknown, token = h.admin.token) =>
  h.call(method, path, {
    token,
    body,
  })

const nextAt = (stepMs = 1000) => new Date((clock += stepMs)).toISOString()

let counter = 0

const make = (
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: `${String(++counter).padStart(8, '0')}-1`,
  type,
  at: nextAt(),
  session_id: 'session-1',
  data,
  ...extra,
})

const post = (events: unknown[], id = workspaceId, token = workspaceKey) =>
  api(
    'POST',
    `/v1/sandboxes/${id}/agent/events`,
    {
      events,
    },
    token,
  )

const read = async (query = '') => {
  const reply = await api('GET', `/v1/sandboxes/${workspaceId}/agent/events${query}`)

  assert.equal(reply.status, 200, reply.text)

  return reply.body as {
    items: any[]
    next_since: string
  }
}

const status = async () =>
  (await api('GET', `/v1/sandboxes/${workspaceId}?fields=agent_status`)).body.agent_status

const sql = (text: string, ...params: unknown[]) =>
  (
    h.db as unknown as {
      $client: {
        prepare(sql: string): {
          run(...p: unknown[]): unknown
        }
      }
    }
  ).$client
    .prepare(text)
    .run(...params)

const workspaceOf = async (name: string) => {
  const box = await createSandbox(h, envId, {
    name,
    workspace: {
      agent: 'claude',
      repository: `https://github.com/acme/${name}`,
    },
  })
  const minted = await api('POST', '/v1/tokens', {
    name: `${name}-token`,
    kind: 'scoped',
    scopes: [
      {
        project_id: project.id,
        environment_id: envId,
        level: 'deploy',
      },
    ],
  })
  const row = h.db.select().from(sandbox).where(eq(sandbox.id, box.id)).get()!

  h.db
    .update(sandbox)
    .set({
      workspace: {
        ...row.workspace!,
        token_id: minted.body.id,
      },
    })
    .where(eq(sandbox.id, box.id))
    .run()

  return {
    id: box.id as string,
    key: minted.body.key as string,
  }
}

const forget = () => {
  h.db.delete(agent_event).run()
  h.db
    .update(sandbox)
    .set({
      agent_status: null,
      agent_seq: 0,
    })
    .where(eq(sandbox.id, workspaceId))
    .run()
}

const sse = async (path: string, headers: Record<string, string>, count: number) => {
  const controller = new AbortController()
  const response = await h.fetch(
    new Request(`${localOrigin}${path}`, {
      headers: {
        authorization: `Bearer ${h.admin.token}`,
        accept: 'text/event-stream',
        'x-forwarded-for': '198.51.100.1',
        ...headers,
      },
      signal: controller.signal,
    }),
  )
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: {
    id?: string
    event?: string
    data?: any
  }[] = []
  let buffer = ''

  const next = async () => {
    while (frames.length < count) {
      const { value, done } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value)

      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, cut)

        buffer = buffer.slice(cut + 2)

        if (block.startsWith(':')) {
          continue
        }

        const frame: {
          id?: string
          event?: string
          data?: any
        } = {}

        for (const line of block.split('\n')) {
          const [name, ...rest] = line.split(': ')
          const text = rest.join(': ')

          if (name === 'data') {
            frame.data = JSON.parse(text)
          } else if (name === 'id' || name === 'event') {
            frame[name] = text
          }
        }

        frames.push(frame)
      }
    }
  }

  return {
    frames,
    next,
    stop: () => controller.abort(),
  }
}

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  project = await createProject(h, 'alpha')
  envId = project.default_environment_id

  const workspace = await createSandbox(h, envId, {
    name: 'dev',
    workspace: {
      agent: 'claude',
      repository: 'https://github.com/acme/app',
    },
  })

  workspaceId = workspace.id
  await waitForSandbox(h, workspaceId, 'running')

  const plain = await createSandbox(h, envId, {
    name: 'plain',
  })

  plainId = plain.id

  const minted = await api('POST', '/v1/tokens', {
    name: 'workspace-test',
    kind: 'scoped',
    scopes: [
      {
        project_id: project.id,
        environment_id: envId,
        level: 'deploy',
      },
    ],
  })

  workspaceKey = minted.body.key
  workspaceTokenId = minted.body.id

  const row = h.db.select().from(sandbox).where(eq(sandbox.id, workspaceId)).get()!

  h.db
    .update(sandbox)
    .set({
      workspace: {
        ...row.workspace!,
        token_id: workspaceTokenId,
      },
    })
    .where(eq(sandbox.id, workspaceId))
    .run()

  const patched = await api('PATCH', `/v1/sandboxes/${workspaceId}/variables`, {
    set: [
      {
        key: 'OWN_SEALED',
        kind: 'sealed',
        value: sealed,
      },
    ],
  })

  assert.equal(patched.status, 200, patched.text)
})

after(async () => h.close())

describe('ingest', () => {
  test('stores events with a per-sandbox seq, ignores a repeated id and reports both', async () => {
    forget()

    const first = make('prompt', {
      text: 'fix the test',
    })
    const second = make('tool.started', {
      tool_use_id: 't1',
      name: 'Bash',
      summary: 'pnpm test',
    })
    const reply = await post([first, second])

    assert.equal(reply.status, 202, reply.text)
    assert.deepEqual(reply.body, {
      accepted: 2,
      duplicates: 0,
    })

    const again = await post([first])

    assert.deepEqual(again.body, {
      accepted: 0,
      duplicates: 1,
    })

    const page = await read()

    assert.deepEqual(
      page.items.map((e) => [e.seq, e.type, e.id]),
      [
        [1, 'prompt', first.id],
        [2, 'tool.started', second.id],
      ],
    )
    assert.equal(page.next_since, '2')
  })

  test('answers 404 for a sandbox that is not a workspace and 403 for any other token', async () => {
    const plain = await post(
      [
        make('prompt', {
          text: 'hi',
        }),
      ],
      plainId,
    )

    assert.equal(plain.status, 404, plain.text)

    const admin = await post(
      [
        make('prompt', {
          text: 'hi',
        }),
      ],
      workspaceId,
      h.admin.token,
    )

    assert.equal(admin.status, 403, admin.text)
    assert.equal(admin.body.error.code, 'FORBIDDEN_SCOPE')
  })

  test('rejects an event over the raw limit at its index and a bad time', async () => {
    const big = await post([
      make('prompt', {
        text: 'ok',
      }),
      make('prompt', {
        text: 'x'.repeat(agentEventLimits.raw + 1),
      }),
    ])

    assert.equal(big.status, 400, big.text)
    assert.equal(big.body.error.code, 'VALIDATION_FAILED')
    assert.equal(big.body.error.details.issues[0].path, '/events/1')

    const bad = await post([
      make(
        'prompt',
        {
          text: 'ok',
        },
        {
          at: 'yesterday',
        },
      ),
    ])

    assert.equal(bad.status, 400, bad.text)
    assert.match(bad.body.error.details.issues[0].path, /^\/events\/0(\/|$)/)
  })

  test('has its own budget per sandbox and does not spend the token window', async () => {
    const budgeted = await workspaceOf('budgeted')
    const send = () =>
      post(
        [
          make('omitted', {
            count: 0,
          }),
        ],
        budgeted.id,
        budgeted.key,
      )
    const spent = await Promise.all(
      Array.from(
        {
          length: agentEventLimits.requestsPerMinute,
        },
        send,
      ),
    )

    assert.ok(spent.every((r) => r.status === 202))

    const limited = await send()

    assert.equal(limited.status, 429, limited.text)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)

    for (let i = 0; i < 620; i += 1) {
      await post(
        [
          make('omitted', {
            count: 0,
          }),
        ],
        budgeted.id,
        budgeted.key,
      )
    }

    const other = await api('GET', '/v1/projects', undefined, budgeted.key)

    assert.equal(other.status, 200, other.text)
  })
})

describe('token window on the ingest path', () => {
  test('a token that is not the workspace token spends its own window and gets 429 after 600 a minute', async () => {
    const intruder = await workspaceOf('intruder')
    const statuses: number[] = []

    for (let i = 0; i < 601; i += 1) {
      statuses.push(
        (
          await post(
            [
              make('omitted', {
                count: 0,
              }),
            ],
            workspaceId,
            intruder.key,
          )
        ).status,
      )
    }

    assert.ok(statuses.slice(0, 600).every((status) => status === 403))
    assert.equal(statuses[600], 429)
  })

  test('requests to sandboxes that do not exist spend the token window too', async () => {
    const prober = await workspaceOf('prober')
    const statuses: number[] = []

    for (let i = 0; i < 601; i += 1) {
      statuses.push(
        (
          await post(
            [
              make('omitted', {
                count: 0,
              }),
            ],
            `sbx_${String(i).padStart(24, '0')}`,
            prober.key,
          )
        ).status,
      )
    }

    assert.ok(statuses.slice(0, 600).every((status) => status === 404))
    assert.equal(statuses[600], 429)
  })
})

describe('storage rules', () => {
  test('redacts before it cuts, so no part of a sealed value survives a cut', async () => {
    forget()
    await post([
      make('prompt', {
        text: `${'a'.repeat(agentEventLimits.string - 10)}${sealed} and more`,
      }),
    ])

    const [stored] = (await read()).items

    assert.ok(!stored.data.text.includes('sealed-'))
    assert.ok(stored.data.text.includes('[redacted:OWN_SEALED]'.slice(0, 8)))
    assert.equal(stored.data.truncated, true)
    assert.ok(Buffer.byteLength(stored.data.text) <= agentEventLimits.string)
  })

  test('redacts again at serve time with the set the sandbox has then', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'the late secret is late-secret-value-0123456789',
      }),
    ])

    const before = (await read()).items[0].data.text

    assert.ok(before.includes('late-secret-value-0123456789'))

    const patched = await api('PATCH', `/v1/sandboxes/${workspaceId}/variables`, {
      set: [
        {
          key: 'LATE_SEALED',
          kind: 'sealed',
          value: 'late-secret-value-0123456789',
        },
      ],
    })

    assert.equal(patched.status, 200, patched.text)
    assert.ok(!JSON.stringify((await read()).items).includes('late-secret-value'))
  })

  test('drops the output of a call that worked, keeps 512 bytes of a failed one, and 4 KiB of every call when the setting is on', async () => {
    forget()

    const finished = (id: string, is_error: boolean) =>
      make('tool.finished', {
        tool_use_id: id,
        name: 'Bash',
        summary: 'run',
        is_error,
        output: 'y'.repeat(6000),
      })

    await post([finished('ok', false), finished('bad', true)])

    const [worked, failed] = (await read()).items

    assert.equal(worked.data.output, undefined)
    assert.equal(Buffer.byteLength(failed.data.output), agentEventLimits.failedOutput)
    assert.equal(failed.data.truncated, true)

    writeSetting(h.db, 'sandbox.agent_events_output', true, {
      type: 'system',
      id: null,
      client: 'test',
    })

    await post([finished('on', false)])

    const kept = (await read()).items.at(-1)

    assert.equal(Buffer.byteLength(kept.data.output), agentEventLimits.toolOutput)

    h.db.delete(agent_event).run()
    sql("delete from setting where key = 'sandbox.agent_events_output'")
  })

  test('joins the parts of a message on final, redacts the joined text and never stores a part', async () => {
    forget()

    const part = (index: number, text: string, final: boolean) =>
      make('message.part', {
        message_id: 'm1',
        index,
        final,
        text,
      })

    await post([part(0, 'The key is sealed-value-', false), part(1, '0123456789abcdef.', true)])

    const items = (await read()).items

    assert.deepEqual(
      items.map((e) => e.type),
      ['message'],
    )
    assert.equal(items[0].data.text, 'The key is [redacted:OWN_SEALED].')
    assert.equal(rows(h, "select * from agent_event where type = 'message.part'").length, 0)
  })

  test('joins a message that never gets a final after 60 s without a part', async () => {
    forget()
    mock.timers.enable({
      apis: ['setTimeout'],
    })

    try {
      await post([
        make('message.part', {
          message_id: 'm2',
          index: 0,
          final: false,
          text: 'half a thought',
        }),
      ])
      assert.equal((await read()).items.length, 0)
      mock.timers.tick(agentEventLimits.partsIdleS * 1000)
    } finally {
      mock.timers.reset()
    }

    assert.deepEqual(
      (await read()).items.map((e) => e.data.text),
      ['half a thought'],
    )
  })
})

describe('idle flush failure', () => {
  test('is logged as sandbox.agent_events_flush_failed and does not throw out of the timer', () => {
    forget()
    mock.timers.enable({
      apis: ['setTimeout'],
    })

    const logged: {
      event: string
      fields?: Record<string, unknown>
    }[] = []
    let broken = false
    const row = h.db.select().from(sandbox).where(eq(sandbox.id, workspaceId)).get()!

    try {
      ingestAgentEvents(
        h.db,
        row,
        [
          make('message.part', {
            message_id: 'm-broken',
            index: 0,
            final: false,
            text: 'half',
          }) as never,
        ],
        (text) => {
          if (broken) {
            throw new Error('redactor failed')
          }

          return text
        },
        (event, fields) =>
          logged.push({
            event,
            fields,
          }),
      )
      broken = true
      assert.doesNotThrow(() => mock.timers.tick(agentEventLimits.partsIdleS * 1000))
    } finally {
      mock.timers.reset()
    }

    assert.equal(logged[0]?.event, 'sandbox.agent_events_flush_failed')
    assert.equal(logged[0]?.fields?.explanation, 'redactor failed')
  })
})

describe('status', () => {
  const kinds = async (events: ReturnType<typeof make>[]) => {
    await post(events)

    return status()
  }

  test('follows the table and emits sandbox.agent_status on a change', async () => {
    forget()
    sql("delete from event where type = 'sandbox.agent_status'")

    assert.equal((await status()).status, 'none')

    const started = await kinds([
      make('session.started', {
        source: 'startup',
      }),
    ])

    assert.equal(started.status, 'ready')
    assert.equal(
      (
        await kinds([
          make('prompt', {
            text: 'go',
          }),
        ])
      ).status,
      'working',
    )
    assert.equal(
      (
        await kinds([
          make('attention', {
            kind: 'question',
            message: 'which one?',
          }),
        ])
      ).status,
      'waiting',
    )
    assert.equal((await status()).kind, 'question')
    assert.equal(
      (
        await kinds([
          make('attention', {
            kind: 'permission',
            tool: 'Bash',
          }),
        ])
      ).kind,
      'question',
    )
    assert.equal(
      (
        await kinds([
          make('tool.finished', {
            tool_use_id: 't',
            name: 'Bash',
            summary: 'x',
            is_error: false,
          }),
        ])
      ).status,
      'working',
    )
    assert.equal((await kinds([make('turn.ended', {})])).status, 'ready')
    assert.equal(
      (
        await kinds([
          make('turn.failed', {
            error: 'rate_limit',
          }),
        ])
      ).status,
      'failed',
    )
    assert.equal(
      (
        await kinds([
          make('session.ended', {
            reason: 'other',
          }),
        ])
      ).status,
      'ended',
    )

    const emitted = h.db.select().from(event).where(eq(event.type, 'sandbox.agent_status')).all()

    assert.deepEqual(
      emitted.map(
        (e) =>
          (
            e.payload as {
              status: string
            }
          ).status,
      ),
      ['ready', 'working', 'waiting', 'working', 'ready', 'failed', 'ended'],
    )
  })

  test('never moves status back for an event older than the one that set it', async () => {
    forget()

    const late = make('tool.finished', {
      tool_use_id: 'late',
      name: 'Bash',
      summary: 'x',
      is_error: false,
    })

    await post([
      make('prompt', {
        text: 'go',
      }),
    ])
    await post([make('turn.ended', {})])
    await post([late])

    const current = await status()

    assert.equal(current.status, 'ready')
    assert.equal((await read()).items.at(-1).type, 'tool.finished')
  })

  test('tool events and messages of a turn that already ended leave the status alone', async () => {
    forget()

    const tool = (id: string, prompt: string) =>
      make(
        'tool.finished',
        {
          tool_use_id: id,
          name: 'Bash',
          summary: 'x',
          is_error: false,
        },
        {
          prompt_id: prompt,
        },
      )

    await post([
      make(
        'prompt',
        {
          text: 'go',
        },
        {
          prompt_id: 'p1',
        },
      ),
    ])
    await post([
      make(
        'turn.ended',
        {},
        {
          prompt_id: 'p1',
        },
      ),
    ])
    await post([tool('after-stop', 'p1')])
    assert.equal((await status()).status, 'ready')

    await post([
      make(
        'message',
        {
          message_id: 'm',
          text: 'flushed late',
        },
        {
          prompt_id: 'p1',
        },
      ),
    ])
    assert.equal((await status()).status, 'ready')

    await post([
      make(
        'prompt',
        {
          text: 'next',
        },
        {
          prompt_id: 'p2',
        },
      ),
    ])
    await post([tool('in-next', 'p2')])
    assert.equal((await status()).status, 'working')
  })

  test('a background subagent keeps the status working after the main turn ended, from its first tool to the main wake-up and the next end', async () => {
    forget()

    const step = (type: string, prompt: string | undefined, agent?: string, data = {}) =>
      make(type, data, {
        session_id: 'bg',
        ...(prompt
          ? {
              prompt_id: prompt,
            }
          : {}),
        ...(agent
          ? {
              agent_id: agent,
            }
          : {}),
      })
    const tool = (type: string, prompt: string, agent?: string) =>
      step(
        type,
        prompt,
        agent,
        type === 'tool.started'
          ? {
              tool_use_id: 't',
              name: 'Bash',
              summary: 'x',
            }
          : {
              tool_use_id: 't',
              name: 'Bash',
              summary: 'x',
              is_error: false,
            },
      )
    const after = async (events: ReturnType<typeof make>[]) => {
      await post(events)

      return status()
    }

    assert.equal((await after([step('session.started', undefined)])).status, 'ready')
    assert.equal(
      (
        await after([
          step('prompt', 'a915', undefined, {
            text: 'go',
          }),
        ])
      ).status,
      'working',
    )
    await post([tool('tool.started', 'a915'), step('subagent.started', 'a915', 'a408')])
    assert.deepEqual((await status()).agents, ['a408'])

    const ended = await after([tool('tool.finished', 'a915'), step('turn.ended', 'a915')])

    assert.equal(ended.status, 'working')
    assert.deepEqual(ended.agents, ['a408'])
    assert.equal((await after([tool('tool.started', 'a915', 'a408')])).status, 'working')
    assert.equal((await after([tool('tool.finished', 'a915', 'a408')])).status, 'working')

    const woken = await after([
      step('prompt', 'fe47', undefined, {
        text: 'result?',
      }),
      step('subagent.stopped', 'fe47', 'a408'),
    ])

    assert.equal(woken.status, 'working')
    assert.deepEqual(woken.agents, [])
    assert.equal(
      (await after([tool('tool.started', 'fe47'), tool('tool.finished', 'fe47')])).status,
      'working',
    )
    assert.equal((await after([step('turn.ended', 'fe47')])).status, 'ready')
  })

  test('the last subagent stopping after the main turn ended makes the status ready, and a session end clears the running agents', async () => {
    forget()
    await post([
      make(
        'prompt',
        {
          text: 'go',
        },
        {
          session_id: 'bg2',
          prompt_id: 'p1',
        },
      ),
      make(
        'subagent.started',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
          agent_id: 'x',
        },
      ),
      make(
        'subagent.started',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
          agent_id: 'y',
        },
      ),
      make(
        'turn.ended',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
        },
      ),
    ])
    assert.equal((await status()).status, 'working')

    await post([
      make(
        'subagent.stopped',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
          agent_id: 'x',
        },
      ),
    ])
    assert.equal((await status()).status, 'working')
    assert.deepEqual((await status()).agents, ['y'])

    await post([
      make(
        'subagent.stopped',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
          agent_id: 'y',
        },
      ),
    ])
    assert.equal((await status()).status, 'ready')

    await post([
      make(
        'subagent.started',
        {},
        {
          session_id: 'bg2',
          prompt_id: 'p1',
          agent_id: 'z',
        },
      ),
      make(
        'session.ended',
        {},
        {
          session_id: 'bg2',
        },
      ),
    ])
    assert.equal((await status()).status, 'ended')
    assert.deepEqual((await status()).agents, [])
  })

  test('a session.started of a new session resets a crashed session, and one of the same session keeps the status', async () => {
    forget()
    await post([
      make(
        'session.started',
        {},
        {
          session_id: 'old',
        },
      ),
      make(
        'prompt',
        {
          text: 'go',
        },
        {
          session_id: 'old',
        },
      ),
      make(
        'attention',
        {
          kind: 'question',
        },
        {
          session_id: 'old',
        },
      ),
    ])
    assert.equal((await status()).status, 'waiting')

    await post([
      make(
        'session.started',
        {
          source: 'compact',
        },
        {
          session_id: 'old',
        },
      ),
    ])
    assert.equal((await status()).status, 'waiting')
    assert.equal((await status()).kind, 'question')

    await post([
      make(
        'session.started',
        {
          source: 'startup',
        },
        {
          session_id: 'new',
        },
      ),
    ])

    const fresh = await status()

    assert.equal(fresh.status, 'ready')
    assert.equal(fresh.kind, null)
    assert.equal(fresh.session_id, 'new')
  })

  test('is none again once the sandbox stops, and the sandbox summary carries it for a workspace only', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'go',
      }),
    ])
    assert.equal((await status()).status, 'working')

    const stopped = await api('POST', `/v1/sandboxes/${workspaceId}/stop`)

    assert.equal(stopped.status, 200, stopped.text)
    await waitForSandbox(h, workspaceId, 'stopped')
    assert.equal((await status()).status, 'none')

    const plain = await api('GET', `/v1/sandboxes/${plainId}?fields=agent_status`)

    assert.equal(plain.body.agent_status, null)

    const start = await api('POST', `/v1/sandboxes/${workspaceId}/start`)

    assert.equal(start.status, 200, start.text)
    await waitForSandbox(h, workspaceId, 'running')
  })
})

describe('reading one session', () => {
  test('a session filter without a cursor starts at the first event of that session', async () => {
    forget()
    await post([
      make(
        'session.started',
        {},
        {
          session_id: 'older',
        },
      ),
      make(
        'prompt',
        {
          text: 'first',
        },
        {
          session_id: 'older',
        },
      ),
      make(
        'session.started',
        {},
        {
          session_id: 'newer',
        },
      ),
      make(
        'prompt',
        {
          text: 'second',
        },
        {
          session_id: 'newer',
        },
      ),
    ])

    assert.deepEqual(
      (await read('?session=older')).items.map((e) => e.type),
      ['session.started', 'prompt'],
    )
    assert.deepEqual(
      (await read('')).items.map((e) => e.session_id),
      ['newer', 'newer'],
    )
  })
})

describe('retention and caps', () => {
  test('sweeps events older than the retention setting and keeps newer ones', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'old',
      }),
      make('prompt', {
        text: 'new',
      }),
    ])
    sql('update agent_event set received_at = ? where seq = 1', Date.now() - 8 * 86400_000)

    const result = sweepAgentEvents(h.db)

    assert.equal(result.expired, 1)
    assert.deepEqual(
      (await read()).items.map((e) => e.data.text),
      ['new'],
    )
  })

  test('a sweep of every row does not make the next event reuse a seq', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'a',
      }),
      make('prompt', {
        text: 'b',
      }),
    ])
    sql('update agent_event set received_at = ?', Date.now() - 8 * 86400_000)

    assert.equal(sweepAgentEvents(h.db).expired, 2)

    await post([
      make('prompt', {
        text: 'c',
      }),
    ])

    assert.deepEqual(
      (await read('?since=2')).items.map((e) => [e.seq, e.data.text]),
      [[3, 'c']],
    )
  })

  test('keeps the newest events within a count cap and a byte cap, oldest deleted first', async () => {
    forget()
    await post(
      Array.from(
        {
          length: 10,
        },
        (_, i) =>
          make('prompt', {
            text: `p${i}`,
          }),
      ),
    )

    const limits = {
      ...agentEventLimits,
      perSandboxCount: 4,
    }

    assert.equal(enforceAgentCaps(h.db, workspaceId, limits), 6)
    assert.deepEqual(
      (await read()).items.map((e) => e.seq),
      [7, 8, 9, 10],
    )

    const bytes = rows<{
      bytes: number
    }>(h, 'select bytes from agent_event').map((r) => r.bytes)
    const cap = bytes[0]! * 2

    assert.equal(
      enforceAgentCaps(h.db, workspaceId, {
        ...agentEventLimits,
        perSandboxBytes: cap,
      }),
      2,
    )
    assert.equal(rows(h, 'select 1 from agent_event').length, 2)
  })

  test('deleting the sandbox deletes its events', async () => {
    const box = await createSandbox(h, envId, {
      name: 'gone',
      workspace: {
        agent: 'claude',
        repository: 'https://github.com/acme/gone',
      },
    })
    const row = h.db.select().from(sandbox).where(eq(sandbox.id, box.id)).get()!

    ingestAgentEvents(
      h.db,
      row,
      [
        make('prompt', {
          text: 'bye',
        }) as never,
      ],
      (text) => text,
      () => {},
    )
    assert.equal(rows(h, 'select 1 from agent_event where sandbox_id = ?', box.id).length, 1)

    const deleted = await api('DELETE', `/v1/sandboxes/${box.id}`)

    assert.equal(deleted.status, 200, deleted.text)
    await waitForSandbox(h, box.id, 'deleting').catch(() => undefined)

    for (
      let i = 0;
      i < 100 && rows(h, 'select 1 from sandbox where id = ?', box.id).length;
      i += 1
    ) {
      h.deps.stations.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    assert.equal(rows(h, 'select 1 from agent_event where sandbox_id = ?', box.id).length, 0)
  })
})

describe('reading', () => {
  test('is for an instance admin only: a workspace token, a read token and a project admin are refused', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'secret plans',
      }),
    ])

    for (const [key, level] of [
      [workspaceKey, 'deploy'],
      [null, 'read'],
      [null, 'admin'],
    ] as const) {
      const token =
        key ??
        (
          await api('POST', '/v1/tokens', {
            name: `reader-${level}`,
            kind: 'scoped',
            scopes: [
              {
                project_id: project.id,
                environment_id: '*',
                level,
              },
            ],
          })
        ).body.key
      const reply = await api('GET', `/v1/sandboxes/${workspaceId}/agent/events`, undefined, token)

      assert.equal(reply.status, 403, `${level}: ${reply.text}`)
      assert.equal(reply.body.error.code, 'INSTANCE_SCOPE_REQUIRED')
    }
  })

  test('hides both agent routes from MCP in the OpenAPI document', async () => {
    const doc = (await api('GET', '/openapi/json')).body

    for (const [path, method] of [
      ['/v1/sandboxes/{sandbox}/agent/events', 'post'],
      ['/v1/sandboxes/{sandbox}/agent/events', 'get'],
    ] as const) {
      assert.equal(doc.paths[path][method]['x-stationly'].mcp, false)
    }

    assert.deepEqual(doc.paths['/v1/sandboxes/{sandbox}/agent/events'].get['x-stationly'].cli, {
      path: ['sandboxes', 'agent'],
    })
  })

  test('pages after a seq, filters by session and starts at the newest session start', async () => {
    forget()
    await post([
      make('session.started', {
        source: 'startup',
      }),
      make('prompt', {
        text: 'one',
      }),
      make(
        'session.started',
        {
          source: 'startup',
        },
        {
          session_id: 'session-2',
        },
      ),
      make(
        'prompt',
        {
          text: 'two',
        },
        {
          session_id: 'session-2',
        },
      ),
    ])

    assert.deepEqual(
      (await read()).items.map((e) => e.seq),
      [3, 4],
    )
    assert.deepEqual(
      (await read('?since=0&session=session-1')).items.map((e) => e.seq),
      [1, 2],
    )
    assert.deepEqual(
      (await read('?since=2&limit=1')).items.map((e) => e.seq),
      [3],
    )
  })

  test('streams after Last-Event-ID, follows new events and carries live message parts', async () => {
    forget()
    await post([
      make('prompt', {
        text: 'one',
      }),
      make('prompt', {
        text: 'two',
      }),
    ])

    const stream = await sse(
      `/v1/sandboxes/${workspaceId}/agent/events`,
      {
        'last-event-id': '1',
      },
      3,
    )

    await post([
      make('message.part', {
        message_id: 'live',
        index: 0,
        final: false,
        text: 'typing sealed-value-0123456789abcdef',
      }),
      make('prompt', {
        text: 'three',
      }),
    ])
    await stream.next()
    stream.stop()

    const [replayed, ...rest] = stream.frames
    const live = rest.find((f) => f.event === 'message.part')
    const followed = rest.find((f) => f.event === 'prompt')

    assert.equal(replayed!.id, '2')
    assert.equal(replayed!.event, 'prompt')
    assert.equal(live!.id, undefined)
    assert.ok(live!.data.data.text.includes('[redacted:OWN_SEALED]'))
    assert.equal(followed!.data.data.text, 'three')
  })

  test('sends a live part to the stream as ingest redacted it, without redacting it a second time', async () => {
    forget()

    const echo = await api('PATCH', `/v1/sandboxes/${workspaceId}/variables`, {
      set: [
        {
          key: 'ECHO_SEALED',
          kind: 'sealed',
          value: 'redacted:OWN',
        },
      ],
    })

    assert.equal(echo.status, 200, echo.text)

    try {
      const stream = await sse(`/v1/sandboxes/${workspaceId}/agent/events`, {}, 1)

      await post([
        make('message.part', {
          message_id: 'once',
          index: 0,
          final: false,
          text: `typing ${sealed}`,
        }),
      ])
      await stream.next()
      stream.stop()

      const live = stream.frames.find((f) => f.event === 'message.part')

      assert.equal(live!.data.data.text, 'typing [redacted:OWN_SEALED]')
    } finally {
      await api('PATCH', `/v1/sandboxes/${workspaceId}/variables`, {
        unset: ['ECHO_SEALED'],
      })
    }
  })
})
