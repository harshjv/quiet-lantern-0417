import { useQuery } from '@tanstack/react-query'
import { Tag } from 'lucide-react'

import { KeyValue, Mono, Rows } from '@/components/page'
import { Failure } from '@/components/panel'
import { EmptyRow, TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { InventoryComponent, Station } from '@/lib/api'
import { plural } from '@/lib/format'
import { inventoryQuery, releasesQuery } from '@/lib/queries'
import { Section } from '@/workbench/parts'
import { upgradeActive, UpgradeButton, UpgradeProgress } from '@/workbench/server-upgrade'

const shortDigest = (digest: string | null) => digest?.replace(/^sha256:/, '').slice(0, 12) ?? '—'

export function ComponentsTable({
  items,
  stations,
}: {
  items: InventoryComponent[]
  stations: Pick<Station, 'id' | 'name'>[]
}) {
  const stationName = (id: string | null) =>
    id === null ? 'Instance' : (stations.find((station) => station.id === id)?.name ?? id)

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead className="hidden sm:table-cell">Server</TableHead>
          <TableHead>Version</TableHead>
          <TableHead className="hidden md:table-cell">Digest</TableHead>
          <TableHead className="hidden md:table-cell">Since</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 && (
          <EmptyRow columns={5}>No components are installed from a release yet.</EmptyRow>
        )}
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <Mono className="font-medium">{item.name}</Mono>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {stationName(item.server_id)}
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

function Newer() {
  const { data } = useQuery(releasesQuery)

  if (!data) {
    return null
  }

  if (!data.enabled) {
    return <span className="text-sm text-muted-foreground">Release checks are off</span>
  }

  return (
    <span className="text-sm text-muted-foreground">
      {data.available.length === 0
        ? 'No newer release found'
        : plural(data.available.length, 'newer release')}
    </span>
  )
}

export function ReleaseSection({ stations }: { stations: Pick<Station, 'id' | 'name'>[] }) {
  const { data, error, refetch } = useQuery({
    ...inventoryQuery,
    refetchInterval: (query) => (upgradeActive(query.state.data?.upgrade) ? 3000 : false),
  })
  const release = data?.release
  const drift = data?.items.filter((item) => item.drift) ?? []

  return (
    <Section
      icon={Tag}
      title="Release"
      note="The Stationly release this instance runs and the version of each component."
      facts={<Newer />}
      action={<UpgradeButton current={release?.version ?? null} upgrade={data?.upgrade ?? null} />}
    >
      {error ? (
        <Failure error={error} title="Couldn’t load the release" onRetry={() => void refetch()} />
      ) : !data ? (
        <Rows count={2} />
      ) : (
        <>
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
              ['Drift', drift.length === 0 ? 'None' : plural(drift.length, 'component')],
            ]}
          />
          {data.upgrade && <UpgradeProgress upgrade={data.upgrade} stations={stations} />}
          <ComponentsTable items={data.items} stations={stations} />
        </>
      )}
    </Section>
  )
}
