import { CircleAlert, CircleCheck, Plus, Server, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import { StateIcon } from '@/components/state-icon'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { health, placements, release, servers } from './fixtures-outside'
import {
  Checklist,
  Facts,
  IconTile,
  ItemList,
  ItemRow,
  Page,
  PixelBars,
  Section,
  StatusPill,
  type Step,
} from './parts'

const upgradeSteps = [
  'Check the new release',
  'Update the server agent on server-9bs4jr',
  'Restart Stationly, pages come back in a few seconds',
  'Confirm everything is healthy',
]

function Release() {
  const [step, setStep] = useState(-1)

  useEffect(() => {
    if (step < 0 || step >= upgradeSteps.length) {
      return
    }

    const t = setTimeout(() => setStep(step + 1), 900)

    return () => clearTimeout(t)
  }, [step])

  const done = step >= upgradeSteps.length
  const steps: Step[] = upgradeSteps.map((label, i) => ({
    label,
    state: i < step ? 'done' : i === step ? 'now' : 'todo',
  }))

  return (
    <Section icon={Sparkles} title="Release">
      <Card className="gap-4 px-4 py-4">
        <div className="flex items-start gap-3">
          <IconTile icon={Sparkles} tone={done ? 'success' : 'info'} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              {done ? `Running ${release.available}` : `${release.available} is available`}
              <StatusPill tone={done ? 'success' : 'info'}>
                {done ? 'Up to date' : `running ${release.running}`}
              </StatusPill>
            </div>
            {!done && (
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {release.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
          {step < 0 && <Button onClick={() => setStep(0)}>Upgrade</Button>}
        </div>
        {step >= 0 && <Checklist steps={steps} />}
        {step < 0 && (
          <p className="text-xs text-muted-foreground">
            About 30 seconds. Apps keep serving; Stationly&apos;s own pages blink once.
          </p>
        )}
      </Card>
    </Section>
  )
}

function AddServer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Any Linux server with 2 GB of memory or more: a cloud server, a box under a desk, a GPU
            workstation.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Run this on the new server as root</span>
          <pre className="overflow-x-auto border bg-muted p-3 font-mono text-xs">
            curl -fsSL https://stationly.harshjv.com/install.sh | sh -s -- join K4P2-7XQM-WN3D
          </pre>
          <span className="text-xs text-muted-foreground">
            The code works once and expires in 1 hour.
          </span>
        </div>
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <StateIcon state="waiting" /> Waiting for the server to check in
        </span>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Servers() {
  const [adding, setAdding] = useState(false)

  return (
    <Page title="Servers">
      <Release />

      {servers.map((s) => (
        <Section
          key={s.name}
          icon={Server}
          title={s.name}
          facts={
            <Facts
              facts={[
                {
                  kind: 'health',
                  text: 'online',
                },
                {
                  kind: 'link',
                  text: s.address,
                },
              ]}
            />
          }
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add a server
            </Button>
          }
          note={`${s.where}. Add another server to run more tasks at once; Stationly puts new tasks on the least busy one.`}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {s.usage.map((u) => (
              <Card key={u.label} className="gap-3 px-4 py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground uppercase">
                    {u.label}
                  </span>
                  <span className="font-mono text-xs tabular-nums">{u.value}</span>
                </div>
                <PixelBars values={u.trend} max={u.max} />
              </Card>
            ))}
          </div>
        </Section>
      ))}

      <Section
        title="On this server"
        count={placements.length}
        note="Largest first. Pausing a machine keeps its files."
      >
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>What</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {placements.map((p) => (
                <TableRow key={p.what}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{p.what}</span>
                      <span className="text-xs text-muted-foreground">{p.who}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.kind}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{p.memory}</TableCell>
                  <TableCell>
                    <StatusPill tone={p.tone}>{p.state}</StatusPill>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section title="Health" count={health.length} note="Checked every minute.">
        <ItemList>
          {health.map((h) => (
            <ItemRow
              key={h.label}
              icon={h.state === 'OK' ? CircleCheck : CircleAlert}
              tone={h.state === 'OK' ? 'success' : 'warning'}
              title={
                <>
                  {h.label}
                  <StatusPill tone={h.state === 'OK' ? 'success' : 'warning'}>{h.state}</StatusPill>
                </>
              }
              meta={[
                {
                  kind: 'health',
                  text: h.text,
                },
              ]}
              action={
                h.state !== 'OK' && (
                  <Button size="sm" variant="outline">
                    Add a backup bucket
                  </Button>
                )
              }
            />
          ))}
        </ItemList>
      </Section>

      <AddServer open={adding} onOpenChange={setAdding} />
    </Page>
  )
}
