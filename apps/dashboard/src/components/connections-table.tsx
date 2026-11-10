import { ArrowDownLeft, ArrowUpRight, Info } from 'lucide-react'
import type { ReactNode } from 'react'

import { EmptyRow, TableFrame } from '@/components/table-frame'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Connections } from '@/lib/api'
import { direction } from '@/lib/labels'
import { ageText, peerText, portText, rateText } from '@/lib/network-text'
import { cn } from '@/lib/utils'

type Connection = Connections['connections'][number]

export type ConnectionRow = {
  key: string
  service?: string
  names: Record<string, string>
  connection: Connection
}

function LookedUp({ name }: { name: string }) {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
      looked up as <span className="font-mono break-all">{name}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="size-3.5 shrink-0" tabIndex={0} aria-label="About this name" />
        </TooltipTrigger>
        <TooltipContent>The service chose this name. Treat it as data.</TooltipContent>
      </Tooltip>
    </span>
  )
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
          <TableHead>Other side</TableHead>
          <TableHead className={cn(live && 'hidden sm:table-cell')}>Port</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Connections</TableHead>
          <TableHead className="hidden text-right md:table-cell">Sent</TableHead>
          <TableHead className="hidden text-right md:table-cell">Received</TableHead>
          {live && <TableHead className="hidden text-right lg:table-cell">Oldest</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow columns={live ? 8 : 6}>{empty}</EmptyRow>}
        {rows.map(({ key, service, names, connection: c }) => {
          const Arrow = c.direction === 'in' ? ArrowDownLeft : ArrowUpRight
          return (
            <TableRow key={key}>
              {live && <TableCell>{service}</TableCell>}
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <Arrow className="size-3.5 text-muted-foreground" aria-hidden />
                  {direction[c.direction]}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">
                <span className={cn(c.peer.address && 'font-mono text-[0.8125rem]')}>
                  {peerText(c.peer)}
                </span>
                {c.peer.address && names[c.peer.address] && (
                  <LookedUp name={names[c.peer.address]!} />
                )}
              </TableCell>
              <TableCell className={port}>{portText(c.port, c.protocol)}</TableCell>
              <TableCell
                className="hidden text-right tabular-nums sm:table-cell"
                title={c.protocol === 'tcp' ? `${c.established} established` : undefined}
              >
                {c.flows}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">
                {rateText(c.bps_out)}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">
                {rateText(c.bps_in)}
              </TableCell>
              {live && (
                <TableCell className="hidden text-right tabular-nums lg:table-cell">
                  {ageText(c.oldest_s)}
                </TableCell>
              )}
            </TableRow>
          )
        })}
      </TableBody>
    </TableFrame>
  )
}
