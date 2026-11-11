import type { MessageBody } from '@stationly/protocol'

import type { Api, Data } from '../kit.ts'
import { human, progress } from '../output.ts'

type LogPage = Data<Api['logs']['get']>

export type LogLine = LogPage['untrusted']['lines'][number]

type Sample = MessageBody<'metrics.sample.result'>['samples'][number]

type EventPage = Data<Api['events']['get']>

type EventRow = EventPage['items'][number]

export const lineText = (line: LogLine) =>
  `${line.at} ${line.stream === 'stderr' ? 'E' : ' '} ${line.role && line.role !== 'service' ? `[${line.role}] ` : ''}${line.text}`

export const logPageText = (page: LogPage) => {
  if (page.next_cursor) {
    progress(`next: --cursor ${page.next_cursor}`)
  }

  if (page.truncated) {
    progress('the cursor pointed at a deleted segment; reading started at the oldest line')
  }

  return page.untrusted.lines.map(lineText).join('\n')
}

export const logEventText = (line: LogLine, name: string) =>
  name === 'log' ? lineText(line) : null

export const metricsEventText = (sample: Sample, name: string) =>
  name === 'metrics'
    ? `${sample.at} ${sample.service_id} cpu ${sample.cpu_pct.toFixed(2)}% mem ${sample.memory_bytes}/${sample.memory_limit_bytes} net rx ${sample.net_rx_bps} B/s tx ${sample.net_tx_bps} B/s blk r ${sample.blk_read_bps} w ${sample.blk_write_bps} restarts ${sample.restarts}`
    : null

export const eventPageText = (page: EventPage) => {
  if (page.next_since) {
    progress(`resume: --since ${page.next_since}`)
  }

  return human(page)
}

export const eventRowText = (row: EventRow) =>
  `${row.created_at} ${row.id} ${row.type} ${row.subject.entity}:${row.subject.id} ${JSON.stringify(row.payload)}`
