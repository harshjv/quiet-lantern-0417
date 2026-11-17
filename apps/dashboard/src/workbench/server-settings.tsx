import { useQuery } from '@tanstack/react-query'
import { Package } from 'lucide-react'

import { ComponentsTable } from '@/components/release-section'
import { MachineRuntimeSection } from '@/components/sandbox-runtime'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { inventoryQuery } from '@/lib/queries'

import { Notice, Section } from './parts'
import { versionSkewText, type ServerView } from './server-data'
import { Limits, Placement } from './server-placement'
import { MachineStorage, RemoveServer } from './server-storage'

function Components({ server }: { server: ServerView }) {
  const { data } = useQuery(inventoryQuery)
  const items = data?.items.filter((item) => item.server_id === server.id) ?? []

  if (items.length === 0) {
    return null
  }

  return (
    <Section icon={Package} title="Components" count={items.length}>
      <ComponentsTable items={items} stations={[server]} />
    </Section>
  )
}

function Health({ server }: { server: ServerView }) {
  const failure = server.generation_failure?.failure

  return (
    <>
      {server.version_skew !== 'ok' && (
        <Notice
          tone={server.version_skew === 'unsupported' ? 'danger' : 'warning'}
          title={`${server.name} runs a different stationd`}
        >
          {versionSkewText[server.version_skew]}
        </Notice>
      )}
      {failure && (
        <Notice tone="danger" title={`${server.name} refused its configuration`}>
          {failure.explanation} {failure.fix}
        </Notice>
      )}
    </>
  )
}

export function ServerSheet({
  server,
  onOpenChange,
}: {
  server: ServerView
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-display text-lg">{server.name}</SheetTitle>
          <SheetDescription className="flex flex-wrap gap-x-3">
            {[server.os, server.arch, server.hosts_dispatch ? 'Runs this instance' : null]
              .filter(Boolean)
              .map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-8 px-4 pb-6">
          <Health server={server} />
          <Placement server={server} />
          <Limits server={server} />
          <MachineRuntimeSection station={server} />
          <MachineStorage server={server} />
          <Components server={server} />
          {!server.hosts_dispatch && (
            <RemoveServer server={server} onRemoved={() => onOpenChange(false)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
