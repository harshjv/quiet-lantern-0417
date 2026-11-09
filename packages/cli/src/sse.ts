import { setTimeout as sleep } from 'node:timers/promises'
import { Exit, exitCodes, isConnectionFailure } from './errors.ts'
import { acrossOutage } from './outage.ts'
import { progress } from './output.ts'

export type SseEvent = { event: string; id: string | null; data: string }

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let id: string | null = null
  let data: string[] = []
  const chunks = (async function* () {
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) yield chunk
    } catch (error) {
      throw new Exit(exitCodes.connection, {
        error: { code: 'CONNECTION_FAILED', explanation: `The stream from Dispatch ended: ${error instanceof Error ? error.message : String(error)}.`, fix: 'Run the command again; pass --since with the last id you saw to resume.' }
      })
    }
  })()
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        if (data.length) yield { event, id, data: data.join('\n') }
        event = 'message'
        id = null
        data = []
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'id') id = value
      else if (field === 'data') data.push(value)
    }
  }
}

export const followSse = async (open: (lastId: string | null) => Promise<Response>, onEvent: (event: SseEvent) => number | undefined, lastId: string | null = null): Promise<number> => {
  for (;;) {
    const response = await acrossOutage(() => open(lastId))
    try {
      for await (const event of readSse(response)) {
        if (event.id) lastId = event.id
        const code = onEvent(event)
        if (code !== undefined) return code
      }
      progress(`The stream from Dispatch closed; reconnecting${lastId ? ` after ${lastId}` : ''}.`)
      await sleep(250)
    } catch (error) {
      if (!isConnectionFailure(error)) throw error
      progress(`${(error as Error).message} Reconnecting${lastId ? ` after ${lastId}` : ''}.`)
    }
  }
}
