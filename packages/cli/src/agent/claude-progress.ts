import type { AgentProgressData } from '@stationly/protocol'

const maxText = 16384

type Block = { key: string; kind: 'thinking' | 'writing'; text: string }

type Line = {
  type?: string
  subtype?: string
  uuid?: string
  parent_tool_use_id?: string | null
  estimated_tokens?: number
  attempt?: number
  error?: string
  event?: {
    type?: string
    index?: number
    message?: { id?: string }
    content_block?: { type?: string }
    delta?: { type?: string; text?: string; thinking?: string }
  }
}

export type ProgressReader = (line: string) => AgentProgressData | null

const parse = (line: string): Line | null => {
  try {
    return JSON.parse(line) as Line
  } catch {
    return null
  }
}

const cut = (text: string) => (text.length > maxText ? text.slice(0, maxText) : text)

export const claudeProgress = (): ProgressReader => {
  let message = ''
  let thinking: Block | null = null
  const blocks = new Map<number, Block>()

  const fromStream = (event: NonNullable<Line['event']>): AgentProgressData | null => {
    const index = event.index ?? 0

    if (event.type === 'message_start') {
      message = event.message?.id ?? ''
      thinking = null
      blocks.clear()

      return null
    }

    if (event.type === 'content_block_start') {
      const kind = event.content_block?.type

      if (kind !== 'thinking' && kind !== 'text') {
        return null
      }

      const block: Block = {
        key: `${message}:${index}`,
        kind: kind === 'thinking' ? 'thinking' : 'writing',
        text: '',
      }

      blocks.set(index, block)

      if (block.kind === 'writing') {
        return null
      }

      thinking = block

      return {
        key: block.key,
        kind: 'thinking',
      }
    }

    if (event.type === 'content_block_stop') {
      if (thinking === blocks.get(index)) {
        thinking = null
      }

      return null
    }

    if (event.type !== 'content_block_delta') {
      return null
    }

    const block = blocks.get(index)
    const piece = event.delta?.text ?? event.delta?.thinking ?? ''

    if (!block || !piece) {
      return null
    }

    block.text = cut(block.text + piece)

    return {
      key: block.key,
      kind: block.kind,
      text: block.text,
    }
  }

  return (raw) => {
    const line = parse(raw)

    if (!line) {
      return null
    }

    if (line.type === 'stream_event' && line.event && !line.parent_tool_use_id) {
      return fromStream(line.event)
    }

    if (line.type !== 'system') {
      return null
    }

    if (line.subtype === 'thinking_tokens' && thinking) {
      return {
        key: thinking.key,
        kind: 'thinking',
        tokens: line.estimated_tokens,
        ...(thinking.text
          ? {
              text: thinking.text,
            }
          : {}),
      }
    }

    if (line.subtype === 'api_retry') {
      return {
        key: `retry:${line.uuid ?? message}`,
        kind: 'retrying',
        attempt: line.attempt,
        error: line.error,
      }
    }

    return null
  }
}
