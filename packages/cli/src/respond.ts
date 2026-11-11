import type { EventSourceMessage } from 'eventsource-parser'

import { repeatUntilDone } from '@stationly/mcp'

import { apiFailure, exitCodes } from './errors.ts'
import { sseHeaders, type Globals, type Sent } from './kit.ts'
import { print, progress } from './output.ts'
import type { Renderer } from './renderers/index.ts'
import { followSse, readSse, streamed } from './sse.ts'

type Input = Record<string, unknown>

type Warning = { code: string; explanation: string }

const typed = (response: Response, type: string) =>
  response.headers.get('content-type')?.includes(type) === true

const printed = (globals: Globals, sent: Sent, { text, exit }: Renderer) => {
  const code = print(globals, sent, text)

  return code === exitCodes.ok && exit ? exit(sent.data) : code
}

const shown = (globals: Globals, { text, event }: Renderer) =>
  streamed('stream', (sse: EventSourceMessage) => {
    const data = JSON.parse(sse.data) as unknown
    const line = event ? event(data, sse.event ?? 'message') : text(data)

    if (line === null) {
      return
    }

    if (globals.json) {
      process.stdout.write(`${sse.data}\n`)

      return
    }

    process.stdout.write(line.includes('\n') ? `${line}\n\n` : `${line}\n`)
  })

export const reply = async (globals: Globals, response: Response, render: Renderer) => {
  if (typed(response, 'text/event-stream')) {
    const show = shown(globals, render)

    for await (const event of readSse(response)) {
      return show(event) ?? exitCodes.ok
    }

    return exitCodes.ok
  }

  if (!typed(response, 'json')) {
    if (response.body) {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        process.stdout.write(chunk)
      }
    }

    return exitCodes.ok
  }

  return printed(
    globals,
    {
      status: response.status,
      data: await response.json(),
    },
    render,
  )
}

export const replyThen = async (
  globals: Globals,
  response: Response,
  render: Renderer,
  then: (data: Input) => Promise<number>,
) => {
  const data = (await response.json()) as Input

  if (response.status === 202) {
    return printed(
      globals,
      {
        status: response.status,
        data,
      },
      render,
    )
  }

  for (const w of (data.warnings as Warning[] | undefined) ?? []) {
    progress(`warning ${w.code}: ${w.explanation}`)
  }

  return then(data)
}

export const follow = (
  globals: Globals,
  open: (headers: Record<string, string>) => Promise<Response>,
  render: Renderer,
) => followSse((lastId) => open(sseHeaders(lastId)), shown(globals, render))

export type Polled = { label: string; wait: string; input: Input }

export const waitUntilDone = async (
  globals: Globals,
  { label, wait, input }: Polled,
  send: (input: Input) => Promise<Response>,
  render: Renderer,
) => {
  let status = 200
  const outcome = await repeatUntilDone({
    name: label,
    wait,
    input,
    attempt: async (next) => {
      const response = await send(next)

      status = response.status

      return {
        ok: true,
        body: await response.json(),
      }
    },
    report: (_, message) => {
      progress(message)
    },
  })

  if (!outcome.ok) {
    throw apiFailure(status, outcome.envelope)
  }

  return printed(
    globals,
    {
      status,
      data: outcome.body,
    },
    render,
  )
}
