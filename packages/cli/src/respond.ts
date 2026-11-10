import { repeatUntilDone } from '@stationly/mcp'

import { apiFailure, exitCodes } from './errors.ts'
import { sseHeaders, type Globals } from './kit.ts'
import { acrossOutage } from './outage.ts'
import { print, progress } from './output.ts'
import type { Render } from './renderers/index.ts'
import { followSse, readSse, streamed, type SseEvent } from './sse.ts'

type Input = Record<string, unknown>

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const accepted = async (response: Response) => {
  if (!response.ok) throw apiFailure(response.status, parsed(await response.text()))
  return response
}

const typed = (response: Response, type: string) =>
  response.headers.get('content-type')?.includes(type) === true

const shown = (globals: Globals, render: Render) =>
  streamed('stream', (event: SseEvent) => {
    if (globals.json) {
      process.stdout.write(`${event.data}\n`)
      return
    }
    const text = render(JSON.parse(event.data))
    process.stdout.write(text.includes('\n') ? `${text}\n\n` : `${text}\n`)
  })

export const reply = async (globals: Globals, sent: Response, render: Render) => {
  const response = await accepted(sent)
  if (typed(response, 'text/event-stream')) {
    const show = shown(globals, render)
    for await (const event of readSse(response)) return show(event) ?? exitCodes.ok
    return exitCodes.ok
  }
  if (!typed(response, 'json')) {
    if (response.body)
      for await (const chunk of response.body as AsyncIterable<Uint8Array>)
        process.stdout.write(chunk)
    return exitCodes.ok
  }
  return print(
    globals,
    {
      status: response.status,
      data: await response.json(),
    },
    render,
  )
}

export const follow = (
  globals: Globals,
  open: (headers: Record<string, string>) => Promise<Response>,
  render: Render,
) => followSse(async (lastId) => accepted(await open(sseHeaders(lastId))), shown(globals, render))

export type Polled = { label: string; wait: string; input: Input }

export const waitUntilDone = async (
  globals: Globals,
  { label, wait, input }: Polled,
  send: (input: Input) => Promise<Response>,
  render: Render,
) => {
  let status = 200
  const outcome = await repeatUntilDone({
    name: label,
    wait,
    input,
    attempt: async (next) => {
      const response = await accepted(await acrossOutage(() => send(next)))
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
  if (!outcome.ok) throw apiFailure(status, outcome.envelope)
  return print(
    globals,
    {
      status,
      data: outcome.body,
    },
    render,
  )
}
