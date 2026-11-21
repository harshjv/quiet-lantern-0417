import {
  setupFailedMarker,
  workspaceSetupStepValues,
  type WorkspaceSetupStep,
} from '@stationly/protocol'

import type { Redactor } from '../api/redaction.ts'
import type { run } from '../db/schema.ts'

type RunRow = typeof run.$inferSelect

const tailLines = 5

const tailChars = 200

const markerOf = (line: string): WorkspaceSetupStep | null => {
  const name = line.startsWith(setupFailedMarker) ? line.slice(setupFailedMarker.length).trim() : ''

  return workspaceSetupStepValues.find((step) => step === name) ?? null
}

export const setupFailureOf = (setup: Pick<RunRow, 'failure'>, redact: Redactor) => {
  const lines = (setup.failure?.logs?.untrusted.text ?? '').split('\n').filter(Boolean)
  const markers = lines.filter((line) => line.startsWith(setupFailedMarker))

  return {
    step: markers.length ? markerOf(markers.at(-1)!) : null,
    tail: lines
      .filter((line) => !line.startsWith(setupFailedMarker))
      .slice(-tailLines)
      .map((line) => redact(line).slice(0, tailChars)),
  }
}
