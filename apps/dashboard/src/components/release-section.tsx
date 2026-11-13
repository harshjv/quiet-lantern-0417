import { useSuspenseQuery } from '@tanstack/react-query'

import { KeyValue, Mono, Section } from '@/components/page'
import { TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { InventoryComponent, Station } from '@/lib/api'
import { inventoryQuery } from '@/lib/queries'

const shortDigest = (digest: string | null) => digest?.replace(/^sha256:/, '').slice(0, 12) ?? '—'

function ComponentsTable({
  items,
  stations,
}: {
  items: InventoryComponent[]
  stations: Station[]
}) {
  const stationName = (id: string | null) =>
    id === null ? 'Instance' : (stations.find((station) => station.id === id)?.name ?? id)

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead className="hidden sm:table-cell">Station</TableHead>
          <TableHead>Version</TableHead>
          <TableHead className="hidden md:table-cell">Digest</TableHead>
          <TableHead className="hidden md:table-cell">Since</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <Mono className="font-medium">{item.name}</Mono>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {stationName(item.station_id)}
            </TableCell>
            <TableCell>
              <span className="inline-flex items-center gap-2">
                <Mono>{item.version}</Mono>
                {item.drift && (
                  <Badge variant="outline" title={`The lockfile pins ${item.lockfile_version}`}>
                    Drift
                  </Badge>
                )}
              </span>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <Mono className="text-muted-foreground">{shortDigest(item.digest)}</Mono>
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">
              <Time value={item.since} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

export function ReleaseSection({ stations }: { stations: Station[] }) {
  const { data } = useSuspenseQuery(inventoryQuery)
  const release = data.release

  return (
    <Section
      title="Release"
      description="The Stationly release this instance runs and the version of each component."
    >
      <KeyValue
        framed
        items={[
          [
            'Version',
            <Mono key="version">{release ? `v${release.version}` : 'Not installed'}</Mono>,
          ],
          ['Channel', release?.channel ?? '—'],
          [
            'Published',
            release?.published_at ? <Time key="published" value={release.published_at} /> : '—',
          ],
          [
            'Upgrade',
            data.upgrade ? `${data.upgrade.status}, to v${data.upgrade.release.to}` : 'None',
          ],
        ]}
      />
      <ComponentsTable items={data.items} stations={stations} />
    </Section>
  )
}
