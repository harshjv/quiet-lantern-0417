import { lazy } from 'react'

import { Panel } from '@/components/panel'
import { api, idempotency, isStarting, unwrap } from '@/lib/api'

const ShellTerminal = lazy(() =>
  import('@/components/shell-terminal').then((m) => ({
    default: m.ShellTerminal,
  })),
)

const startingRetryMs = 2000

export function TaskTerminal({ task }: { task: string }) {
  return (
    <Panel rows={4} title="Couldn’t open the terminal">
      <ShellTerminal
        shellKey={task}
        open={async (starting) => {
          for (;;) {
            try {
              return await unwrap(
                api.v1
                  .tasks({
                    task,
                  })
                  .shells.post(undefined, idempotency()),
              )
            } catch (error) {
              if (!isStarting(error) || !starting()) {
                throw error
              }

              await new Promise((resolve) => setTimeout(resolve, startingRetryMs))
            }
          }
        }}
      />
    </Panel>
  )
}
