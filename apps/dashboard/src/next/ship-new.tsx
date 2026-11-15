import { Boxes, Container, Database, GitBranch, type LucideIcon } from 'lucide-react'
import { useState } from 'react'

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

import { sharedApps } from './fixtures'
import { Notice } from './parts'

type Source = 'repo' | 'database' | 'image' | 'shared'

const sources: { id: Source; icon: LucideIcon; title: string; text: string }[] = [
  {
    id: 'repo',
    icon: GitBranch,
    title: 'From a repository',
    text: 'Build and run code from GitHub',
  },
  {
    id: 'database',
    icon: Database,
    title: 'A database',
    text: 'Postgres, Redis, MySQL',
  },
  {
    id: 'image',
    icon: Container,
    title: 'An image',
    text: 'Any Docker image by name',
  },
  {
    id: 'shared',
    icon: Boxes,
    title: 'A shared app',
    text: 'One the team already runs',
  },
]

export function NewApp({
  project,
  open,
  onOpenChange,
}: {
  project: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [source, setSource] = useState<Source>('repo')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New app in {project}</DialogTitle>
          <DialogDescription>Nothing reaches production until you create it.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-label={s.title}
              aria-pressed={source === s.id}
              onClick={() => setSource(s.id)}
              className={cn(
                'flex items-start gap-3 border p-3 text-left',
                source === s.id ? 'border-primary' : 'hover:bg-muted',
              )}
            >
              <s.icon className="mt-0.5 size-4 shrink-0" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{s.title}</span>
                <span className="text-xs text-muted-foreground">{s.text}</span>
              </span>
            </button>
          ))}
        </div>
        {source === 'shared' ? (
          <div className="flex flex-col gap-3">
            <RadioGroup defaultValue={sharedApps[0]!.name}>
              {sharedApps.map((a) => (
                <Label key={a.name} className="flex items-start gap-3 border p-3 font-normal">
                  <RadioGroupItem value={a.name} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{a.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {a.kind} {a.usedBy.length ? `used by ${a.usedBy.join(', ')}` : 'not used yet'}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              {project} gets a DATABASE_URL key linked to it. Its previews get their own copy, never
              the shared one.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {source === 'repo' && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="repo">Repository</Label>
                  <Input
                    id="repo"
                    defaultValue="harshjv/etherbit-next-api"
                    className="font-mono text-xs"
                  />
                </div>
                <Notice tone="info" title="Found a Node API in apps/admin">
                  It starts with pnpm start and listens on port 4000.
                </Notice>
              </>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" defaultValue={source === 'database' ? 'postgres' : 'admin'} />
            </div>
            {source !== 'database' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="link">Link</Label>
                <Input id="link" defaultValue="admin.etherbit.in" className="font-mono text-xs" />
                <span className="text-xs text-muted-foreground">
                  Leave empty for an app nobody reaches from outside, like a worker.
                </span>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            {source === 'shared' ? `Use in ${project}` : 'Create app'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
