import { Bot, Link2, MessageSquare, Plug } from 'lucide-react'
import { useState } from 'react'

import { StateIcon } from '@/components/state-icon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'

import { assistantKinds, assistants, levels, type Level } from './fixtures-outside'
import { ItemList, ItemRow, Notice, Page, Section, StatusPill } from './parts'

const levelTitle = (id: Level) => levels.find((l) => l.id === id)!.title

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center border font-mono text-xs">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-medium">{title}</span>
        {children}
      </div>
    </div>
  )
}

function Connect({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState(assistantKinds[0]!)
  const [level, setLevel] = useState<Level>('run')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect an assistant</DialogTitle>
          <DialogDescription>
            It acts as you, at the level you choose. Disconnect it any time.
          </DialogDescription>
        </DialogHeader>

        <Step n={1} title="Which assistant?">
          <div className="grid grid-cols-4 gap-2">
            {assistantKinds.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  'border px-2 py-2 text-sm',
                  kind === k ? 'border-primary' : 'hover:bg-muted',
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </Step>

        <Step n={2} title="What can it do?">
          <RadioGroup value={level} onValueChange={(v) => setLevel(v as Level)}>
            {levels.map((l) => (
              <Label key={l.id} className="flex items-start gap-3 border p-3 font-normal">
                <RadioGroupItem value={l.id} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{l.title}</span>
                  <span className="text-xs text-muted-foreground">{l.text}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          {level === 'approve' && (
            <Notice tone="warning" title="It can approve for you">
              {levels.find((l) => l.id === 'approve')!.warn}
            </Notice>
          )}
        </Step>

        <Step n={3} title={`Add Stationly to ${kind}`}>
          <span className="text-xs text-muted-foreground">
            In {kind}, add a custom connector and paste this. {kind} opens a Stationly sign-in;
            approve it there. No key to copy.
          </span>
          <div className="flex gap-2">
            <Input
              readOnly
              value="https://api.try.stationly.harshjv.com/mcp"
              className="font-mono text-xs"
              aria-label="Connector address"
            />
            <Button variant="outline">
              <Link2 /> Copy
            </Button>
          </div>
        </Step>

        <Step n={4} title={`Waiting for ${kind} to connect`}>
          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <StateIcon state="waiting" /> Then try asking: what&apos;s waiting on me in Stationly?
          </span>
        </Step>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Assistants() {
  const [connecting, setConnecting] = useState(false)
  const [gone, setGone] = useState<string[]>([])
  const shown = assistants.filter((a) => !gone.includes(a.name))

  return (
    <Page title="Assistants">
      <Section
        icon={Plug}
        title="Connected"
        count={shown.length}
        note="Let Claude, ChatGPT or Slack check on things or start tasks for you, from wherever you already talk to them."
        action={
          <Button size="sm" onClick={() => setConnecting(true)}>
            <Plug /> Connect an assistant
          </Button>
        }
      >
        {shown.length ? (
          <ItemList>
            {shown.map((a) => (
              <ItemRow
                key={a.name}
                icon={a.name.startsWith('Slack') ? MessageSquare : Bot}
                title={
                  <>
                    {a.name}
                    <StatusPill tone={a.level === 'approve' ? 'warning' : 'info'}>
                      {levelTitle(a.level)}
                    </StatusPill>
                  </>
                }
                meta={[
                  {
                    kind: 'time',
                    text: `last used ${a.used}`,
                  },
                  ...(a.last
                    ? [
                        {
                          kind: 'via' as const,
                          text: a.last,
                        },
                      ]
                    : []),
                ]}
                action={
                  <Button size="sm" variant="outline" onClick={() => setGone([...gone, a.name])}>
                    Disconnect
                  </Button>
                }
              />
            ))}
          </ItemList>
        ) : (
          <p className="text-sm text-muted-foreground">No assistants connected.</p>
        )}
      </Section>
      <Connect open={connecting} onOpenChange={setConnecting} />
    </Page>
  )
}
