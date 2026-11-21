import type { ReactNode } from 'react'

import { Name } from '@/components/name'
import { Time } from '@/components/time'
import type { CanvasServer } from '@/lib/canvas-layout'
import { bytes } from '@/lib/format'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { serverStatus } from './server-data'

export function ServerChip({ server, children }: { server: CanvasServer; children?: ReactNode }) {
  const status = serverStatus[server.status]
  const online = server.status === 'online'

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Name kind="server" className="bg-card text-sm">
        {server.name}
      </Name>
      {online ? (
        server.memory.total !== null && (
          <span className="text-muted-foreground tabular-nums">
            {bytes(server.memory.used)} of {bytes(server.memory.total)}
          </span>
        )
      ) : (
        <>
          <span className={toneText[status.tone]}>{status.label}</span>
          {server.last_seen_at && (
            <span className="text-muted-foreground">
              Last seen <Time value={server.last_seen_at} />
            </span>
          )}
        </>
      )}
      {children}
    </span>
  )
}

export function LaneHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </h2>
      {children}
    </div>
  )
}

export function Lane({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('@container flex flex-col gap-4 p-4', className)}>{children}</section>
  )
}
