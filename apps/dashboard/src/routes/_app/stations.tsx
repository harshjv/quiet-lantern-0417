import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { EmptyState, PageHeader, Section } from '@/components/page'
import { failurePage } from '@/components/panel'
import { SandboxRuntimeSection } from '@/components/sandbox-runtime'
import { byName, plural } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { load, stationsQuery } from '@/lib/queries'
import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/stations')({
  loader: ({ context }) => load(context.queryClient, stationsQuery),
  head: () => titled('Stations'),
  errorComponent: failurePage('Couldn’t load your stations'),
  component: StationsPage,
})

function StationsPage() {
  const { data } = useSuspenseQuery(stationsQuery)

  return (
    <div className="space-y-6">
      <PageHeader title="Stations" meta={<span>{plural(data.items.length, 'station')}</span>} />
      {data.items.length === 0 ? (
        <EmptyState
          icon={entityIcon.station}
          title="No stations yet"
          description="A station is a host that runs your services and sandboxes."
        />
      ) : (
        [...data.items].sort(byName).map((station) => (
          <Section
            key={station.id}
            title={station.name}
            description={[station.arch, station.status].filter(Boolean).join(' · ')}
          >
            <SandboxRuntimeSection station={station} />
          </Section>
        ))
      )}
    </div>
  )
}
