import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { Mono } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
import { DeleteSnapshot, ForkButton } from '@/components/sandbox-actions'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Badge } from '@/components/ui/badge'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { SandboxSnapshot } from '@/lib/api'
import { ago, bytes } from '@/lib/format'

export function SnapshotsTable({
  query,
  project,
  environment,
  originLabel,
  origin,
  empty,
}: {
  query: UseQueryResult<{ items: SandboxSnapshot[] }>
  project: string
  environment: string
  originLabel: string
  origin: (snapshot: SandboxSnapshot) => ReactNode
  empty: ReactNode
}) {
  return (
    <QueryState query={query} rows={2} isEmpty={noItems} empty={empty}>
      {(data) => (
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
            {data.items.map((snapshot) => (
              <TableRow key={snapshot.id}>
                <TableCell>
                  <Mono className="font-medium">{snapshot.name ?? snapshot.id}</Mono>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{snapshot.status}</Badge>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{origin(snapshot)}</TableCell>
                <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
                  {bytes(snapshot.referenced_bytes)}
                </TableCell>
                <TableCell className="text-muted-foreground">{ago(snapshot.taken_at)}</TableCell>
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
      )}
    </QueryState>
  )
}
