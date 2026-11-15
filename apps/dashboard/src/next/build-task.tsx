import { Archive, Copy, ExternalLink, GitFork, MoreHorizontal, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

import { teammates, type Task } from './fixtures'
import { Notice } from './parts'

export type Visibility = 'private' | 'project'

const person = (name: string, role: string, onRemove?: () => void) => (
  <div key={name} className="flex items-center gap-3">
    <Avatar className="size-7">
      <AvatarFallback className="text-xs">{name.slice(0, 1)}</AvatarFallback>
    </Avatar>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-sm">{name}</span>
      <span className="font-mono text-xs text-muted-foreground">{role}</span>
    </div>
    {onRemove && (
      <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={onRemove}>
        <X />
      </Button>
    )}
  </div>
)

export function ShareDialog({
  task,
  visibility,
  onVisibility,
  open,
  onOpenChange,
}: {
  task: Task
  visibility: Visibility
  onVisibility: (v: Visibility) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [handle, setHandle] = useState('')
  const [invited, setInvited] = useState<string[]>([])
  const match = teammates.find((t) => t.handle === handle.trim().replace(/^@/, ''))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this task</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>

        <RadioGroup value={visibility} onValueChange={(v) => onVisibility(v as Visibility)}>
          <Label className="flex items-start gap-3 border p-3 font-normal">
            <RadioGroupItem value="private" className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Only you and people you invite</span>
              <span className="text-xs text-muted-foreground">Nobody else sees it exists.</span>
            </span>
          </Label>
          <Label className="flex items-start gap-3 border p-3 font-normal">
            <RadioGroupItem value="project" className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Everyone in {task.project}</span>
              <span className="text-xs text-muted-foreground">
                They can read it and fork it. Only people you invite can reply.
              </span>
            </span>
          </Label>
        </RadioGroup>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()

            if (match && !invited.includes(match.name)) {
              setInvited([...invited, match.name])
              setHandle('')
            }
          }}
        >
          <Label htmlFor="invite">Invite to reply</Label>
          <div className="flex gap-2">
            <Input
              id="invite"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="GitHub username, like priya-s"
              className="font-mono text-xs"
            />
            <Button type="submit" variant="outline" disabled={!match}>
              Invite
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-3">
          {person('You', 'owner')}
          {invited.map((name) =>
            person(name, 'can reply', () => setInvited(invited.filter((n) => n !== name))),
          )}
        </div>

        {invited.length > 0 && (
          <Notice tone="warning" title="They reply on your keys">
            Their messages use your Claude key, and anything the agent needs approved still comes to
            you.
          </Notice>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type TaskActions = {
  branch: string
  own: boolean
  preview?: () => void
  fork?: () => void
  archive?: () => void
  remove: () => void
}

export function TaskMenu({ branch, own, preview, fork, archive, remove }: TaskActions) {
  const [confirm, setConfirm] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Task actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(branch)}>
            <Copy /> Copy branch name
          </DropdownMenuItem>
          {preview && (
            <DropdownMenuItem onSelect={preview}>
              <ExternalLink /> Open preview
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!fork} onSelect={fork}>
            <GitFork /> Fork into a new task
          </DropdownMenuItem>
          {own && (
            <>
              <DropdownMenuItem disabled={!archive} onSelect={archive}>
                <Archive /> Archive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              The conversation and the machine&apos;s working copy go away for good. The{' '}
              <code className="font-mono text-xs">{branch}</code> branch, its previews and anything
              already in production stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
