import type { Static } from '@sinclair/typebox'

import type { Actor, MessageBody } from '@stationly/protocol'

import type { run } from '../db/schema.ts'

type RunRow = typeof run.$inferSelect

type Session = { tty: boolean; attach: boolean; rows: number | null; cols: number | null }

export const runStartBody = (
  r: RunRow,
  actor: Static<typeof Actor>,
  session: Session,
): MessageBody<'run.start'> => ({
  run_id: r.id,
  service_id: r.app_id,
  deployment_id: r.deployment_id,
  kind: r.kind,
  command: r.command,
  ...session,
  actor,
  ...(r.machine_id
    ? {
        sandbox_id: r.machine_id,
        ...(r.exec?.user
          ? {
              user: r.exec.user,
            }
          : {}),
        ...(r.exec?.cwd
          ? {
              cwd: r.exec.cwd,
            }
          : {}),
        ...(r.exec?.timeout_s
          ? {
              timeout_s: r.exec.timeout_s,
            }
          : {}),
        ...(r.exec?.stdin
          ? {
              stdin: r.exec.stdin,
            }
          : {}),
        ...(r.exec?.record === false
          ? {
              record: false,
            }
          : {}),
      }
    : {}),
})
