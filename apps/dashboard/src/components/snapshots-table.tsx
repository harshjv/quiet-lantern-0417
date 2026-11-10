import type { ReactNode } from 'react'

import { DeleteSnapshot, ForkButton } from '@/components/sandbox-actions'
import { StatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { SandboxSnapshot } from '@/lib/api'
import { bytes } from '@/lib/format'
import { snapshotStatus } from '@/lib/labels'

export function SnapshotsTable({
  snapshots,
  project,
  environment,
  originLabel,
  origin,
  empty,
}: {
  snapshots: SandboxSnapshot[]
  project: string
  environment: string
  originLabel: string
  origin: (snapshot: SandboxSnapshot) => ReactNode
  empty: ReactNode
}) {
  if (snapshots.length === 0) return empty
  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Snapshot</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="hidden sm:table-cell">{originLabel}</TableHead>
          <TableHead className="hidden md:table-cell">Size</TableHead>
          <TableHead>Taken</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {snapshots.map((snapshot) => (
          <TableRow key={snapshot.id}>
            <TableCell>
              <span className="font-mono text-[0.8125rem] font-medium">
                {snapshot.name ?? snapshot.id}
              </span>
            </TableCell>
            <TableCell>
              <StatusBadge
                status={snapshotStatus[snapshot.status]}
                busy={snapshot.status === 'creating' || snapshot.status === 'deleting'}
              />
            </TableCell>
            <TableCell className="hidden sm:table-cell">{origin(snapshot)}</TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
              {bytes(snapshot.referenced_bytes)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              <Time value={snapshot.taken_at} />
            </TableCell>
            <TableCell className="text-right">
              <span className="inline-flex items-center gap-1">
                {snapshot.status === 'ready' && (
                  <ForkButton
                    source={{
                      kind: 'snapshot',
                      snapshot,
                    }}
                    project={project}
                    environment={environment}
                    size="icon-sm"
                  />
                )}
                <DeleteSnapshot snapshot={snapshot} />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}
