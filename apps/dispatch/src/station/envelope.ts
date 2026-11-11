import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import {
  Envelope,
  limits,
  messages,
  type ErrorCode,
  type MessageBody,
  type MessageType,
} from '@stationly/protocol'

import { newId } from '../db/ids.ts'

export type RawEnvelope = Static<typeof Envelope>

export type Decoded =
  | { ok: true; envelope: RawEnvelope }
  | {
      ok: false
      code: 'PROTOCOL_INVALID_MESSAGE' | 'PROTOCOL_UNKNOWN_TYPE'
      explanation: string
      issues: string[]
      envelope?: RawEnvelope
    }

export type ProtocolFailure = {
  code: ErrorCode
  explanation: string
  fix: string
  details?: Record<string, unknown>
}

export const stamp = (date = new Date()) => date.toISOString()

export const newMessageId = () => newId('message')

const issuesOf = (schema: Parameters<typeof Value.Errors>[0], value: unknown) =>
  [...Value.Errors(schema, value)].slice(0, 8).map((e) => `${e.path || '/'}: ${e.message}`)

export const isMessageType = (type: string): type is MessageType => Object.hasOwn(messages, type)

export const decode = (text: string): Decoded => {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID_MESSAGE',
      explanation: `the frame is not JSON: ${(error as Error).message}`,
      issues: [],
    }
  }

  if (!Value.Check(Envelope, value)) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID_MESSAGE',
      explanation: 'the envelope does not match its schema',
      issues: issuesOf(Envelope, value),
    }
  }

  const envelope = value

  if (!isMessageType(envelope.type)) {
    return {
      ok: false,
      code: 'PROTOCOL_UNKNOWN_TYPE',
      explanation: `message type ${envelope.type} is not in the catalog`,
      issues: [],
      envelope,
    }
  }

  const schema = messages[envelope.type].body

  if (!Value.Check(schema, envelope.body)) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID_MESSAGE',
      explanation: `${envelope.type} body does not match its schema`,
      issues: issuesOf(schema, envelope.body),
      envelope,
    }
  }

  return {
    ok: true,
    envelope,
  }
}

export const bodyOf = <T extends MessageType>(envelope: RawEnvelope, _type: T) =>
  envelope.body as MessageBody<T>

export const encode = <T extends MessageType>(
  type: T,
  body: MessageBody<T>,
  options: { ref?: string | null; generation: number },
) => {
  const id = newMessageId()
  const text = JSON.stringify({
    type,
    id,
    ref: options.ref ?? null,
    generation: options.generation,
    sent_at: stamp(),
    body,
  })
  const limit =
    type === 'generation' ? limits.generationInlineBytes + 64 * 1024 : limits.textFrameBytes

  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error(`${type} encodes to more than ${limit} bytes`)
  }

  return {
    id,
    text,
  }
}
