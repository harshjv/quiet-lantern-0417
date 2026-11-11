import { setTimeout as sleep } from 'node:timers/promises'

import type { EventSourceMessage } from 'eventsource-parser'
import { EventSourceParserStream } from 'eventsource-parser/stream'

import { Exit, exitCodes, isConnectionFailure, type EnvelopeCode } from './errors.ts'
import { progress } from './output.ts'

const streamEnded = (error: unknown) =>
  new Exit(exitCodes.connection, {
    error: {
      code: 'CONNECTION_FAILED',
      explanation: `The stream from Dispatch ended: ${error instanceof Error ? error.message : String(error)}.`,
      fix: 'Run the command again; pass --since with the last id you saw to resume.',
    },
  })

export async function* readSse(response: Response): AsyncGenerator<EventSourceMessage> {
  if (!response.body) {
    return
  }

  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  try {
    yield* events
  } catch (error) {
    throw streamEnded(error)
  }
}

export const followSse = async (
  open: (lastId: string | null) => Promise<Response>,
  onEvent: (event: EventSourceMessage) => number | undefined,
  lastId: string | null = null,
): Promise<number> => {
  for (;;) {
    const response = await open(lastId)

    try {
      for await (const event of readSse(response)) {
        if (event.id) {
          lastId = event.id
        }

        const code = onEvent(event)

        if (code !== undefined) {
          return code
        }
      }

      progress(`The stream from Dispatch closed; reconnecting${lastId ? ` after ${lastId}` : ''}.`)
      await sleep(250)
    } catch (error) {
      if (!isConnectionFailure(error)) {
        throw error
      }

      progress(`${(error as Error).message} Reconnecting${lastId ? ` after ${lastId}` : ''}.`)
    }
  }
}

export const streamFailure = (data: string) => {
  const failure = JSON.parse(data) as { code: EnvelopeCode; explanation: string }

  return new Exit(exitCodes.api, {
    error: {
      code: failure.code,
      explanation: failure.explanation,
      fix: 'Retry when the station is connected.',
    },
  })
}

export const streamed =
  (label: string, show: (event: EventSourceMessage) => void) =>
  (event: EventSourceMessage): number | undefined => {
    if (event.event === 'end') {
      progress(`${label} ended: ${(JSON.parse(event.data) as { reason: string }).reason}`)

      return exitCodes.ok
    }

    if (event.event === 'error') {
      throw streamFailure(event.data)
    }

    show(event)

    return undefined
  }
