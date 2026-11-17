import { useSuspenseQuery } from '@tanstack/react-query'
import { Camera, ScrollText } from 'lucide-react'
import { lazy } from 'react'

import { AlsoWith } from '@/components/code'
import { LogViewer } from '@/components/log-viewer'
import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import { CopiedFilesNotice, SnapshotMachine } from '@/components/sandbox-actions'
import { MachineNetwork } from '@/components/sandbox-network'
import { SnapshotsTable } from '@/components/snapshots-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { KeysPanel } from '@/components/variables-panel'
import type { Machine } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { snapshotSource } from '@/lib/labels'
import { go, places, usePlace, viewTab } from '@/lib/nav'
import { machineOwnSnapshotsQuery } from '@/lib/queries'

import { Section } from './parts'

const MachineTerminal = lazy(() =>
  import('@/components/sandbox-terminal').then((m) => ({
    default: m.MachineTerminal,
  })),
)

const tabs = ['terminal', 'keys', 'logs', 'snapshots', 'network'] as const

type Tab = (typeof tabs)[number]

const tabTitle: Record<Tab, string> = {
  terminal: 'Terminal',
  keys: 'Keys',
  logs: 'Logs',
  snapshots: 'Snapshots',
  network: 'Network',
}

function Snapshots({ machine, scope }: { machine: Machine; scope: Scope }) {
  const { data } = useSuspenseQuery(machineOwnSnapshotsQuery(machine.id))

  return (
    <div className="flex flex-col gap-3">
      <CopiedFilesNotice />
      <SnapshotsTable
        snapshots={data.items}
        scope={scope}
        originLabel="Taken"
        origin={(snapshot) => (
          <span className="text-muted-foreground">{snapshotSource[snapshot.source_state]}</span>
        )}
        empty={
          <EmptyState
            icon={Camera}
            title="No snapshots yet"
            description="A snapshot saves this machine’s disk so you can fork new machines from it."
            action={<SnapshotMachine machine={machine} />}
            also={
              <AlsoWith
                cli={commands.snapshotMachine(scope, machine.name)}
                tool="snapshot_machine"
              />
            }
          />
        }
      />
    </div>
  )
}

export function MachineTabs({ machine, scope }: { machine: Machine; scope: Scope }) {
  const place = usePlace()
  const tab = tabs.find((t) => t === viewTab(place.view)) ?? 'terminal'

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        const found = tabs.find((t) => t === next)

        if (found) {
          go(places.machine(machine.id, found))
        }
      }}
    >
      <TabsList>
        {tabs.map((id) => (
          <TabsTrigger key={id} value={id}>
            {tabTitle[id]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="terminal" className="mt-4">
        <Panel rows={4} title="Couldn’t open the terminal">
          <MachineTerminal machine={machine} />
        </Panel>
      </TabsContent>
      <TabsContent value="keys" className="mt-4">
        <KeysPanel
          target={{
            kind: 'machine',
            machine: machine.id,
          }}
          also={<AlsoWith cli={commands.setMachineKey(machine.id)} tool="set_machine_keys" />}
        />
      </TabsContent>
      <TabsContent value="logs" className="mt-4">
        <Section
          icon={ScrollText}
          title="Startup log"
          note="What the machine’s startup process printed since its last start."
        >
          <Panel title="Couldn’t load the startup log">
            <LogViewer
              key={`${machine.id}-${machine.status === 'running'}`}
              selector={{
                machine: machine.id,
                role: 'init',
              }}
              follow={machine.status === 'running'}
              label="Machine startup log"
            />
          </Panel>
        </Section>
      </TabsContent>
      <TabsContent value="snapshots" className="mt-4">
        <Panel rows={2} title="Couldn’t load snapshots">
          <Snapshots machine={machine} scope={scope} />
        </Panel>
      </TabsContent>
      <TabsContent value="network" className="mt-4">
        <MachineNetwork machine={machine} />
      </TabsContent>
    </Tabs>
  )
}
