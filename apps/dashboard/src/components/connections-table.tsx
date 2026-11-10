import type { ReactNode } from 'react'

import { Mono } from '@/components/page'
import { EmptyRow, TableFrame } from '@/components/table-frame'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Connections } from '@/lib/api'
import { ageText, peerText, rateText } from '@/lib/network-layout'
import { cn } from '@/lib/utils'

type Connection = Connections['connections'][number]

export type ConnectionRow = {
  key: string
  service?: string
  names: Record<string, string>
  connection: Connection
}

export function ConnectionsTable({
  rows,
  live,
  caption,
  empty,
}: {
  rows: ConnectionRow[]
  live?: boolean
  caption?: ReactNode
  empty: ReactNode
}) {
  const port = cn('tabular-nums', live && 'hidden sm:table-cell')
  return (
    <TableFrame caption={caption}>
      <TableHeader>
        <TableRow>
          {live && <TableHead>Service</TableHead>}
          <TableHead>Direction</TableHead>
          <TableHead>Peer</TableHead>
          <TableHead className={cn(live && 'hidden sm:table-cell')}>Port</TableHead>
          <TableHead className="hidden sm:table-cell">Flows</TableHead>
          <TableHead className="hidden md:table-cell">Out</TableHead>
          <TableHead className="hidden md:table-cell">In</TableHead>
          {live && <TableHead className="hidden lg:table-cell">Oldest</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow columns={live ? 8 : 6}>{empty}</EmptyRow>}
        {rows.map(({ key, service, names, connection: c }) => (
          <TableRow key={key}>
            {live && <TableCell>{service}</TableCell>}
            <TableCell>{c.direction}</TableCell>
            <TableCell className="whitespace-normal">
              <Mono>{peerText(c.peer)}</Mono>
              {c.peer.address && names[c.peer.address] && (
                <span className="ml-2 text-xs text-muted-foreground">
                  resolved as {names[c.peer.address]}
                </span>
              )}
            </TableCell>
            <TableCell className={port}>
              {c.port}/{c.protocol}
            </TableCell>
            <TableCell className="hidden tabular-nums sm:table-cell">
              {c.flows}
              {live && c.protocol === 'tcp' ? ` (${c.established} established)` : ''}
            </TableCell>
            <TableCell className="hidden tabular-nums md:table-cell">
              {rateText(c.bps_out)}
            </TableCell>
            <TableCell className="hidden tabular-nums md:table-cell">
              {rateText(c.bps_in)}
            </TableCell>
            {live && (
              <TableCell className="hidden tabular-nums lg:table-cell">
                {ageText(c.oldest_s)}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}
