import { Link2, MoreHorizontal, UserPlus } from 'lucide-react'
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
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { useLive } from './data'
import { projects } from './fixtures'
import { invites, members, type Member } from './fixtures-outside'
import { Chips, ItemList, ItemRow, Page, Section } from './parts'
import { LiveTeam } from './team-live'

function Role({ value }: { value: string }) {
  return (
    <RadioGroup defaultValue={value}>
      <Label className="flex items-start gap-3 border p-3 font-normal">
        <RadioGroupItem value="Member" className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Member</span>
          <span className="text-xs text-muted-foreground">
            Their own tasks, tasks shared with them, and the apps of their projects.
          </span>
        </span>
      </Label>
      <Label className="flex items-start gap-3 border p-3 font-normal">
        <RadioGroupItem value="Admin" className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Admin</span>
          <span className="text-xs text-muted-foreground">
            Also servers, team keys, members and settings.
          </span>
        </span>
      </Label>
    </RadioGroup>
  )
}

function ProjectAccess({ chosen }: { chosen: string[] }) {
  const [picked, setPicked] = useState(chosen)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Projects</span>
      {projects.map((p) => {
        const on = picked.includes(p.id)

        return (
          <div key={p.id} className="flex items-center gap-3 border p-3">
            <Checkbox
              id={`project-${p.id}`}
              checked={on}
              onCheckedChange={(c) =>
                setPicked(c ? [...picked, p.id] : picked.filter((x) => x !== p.id))
              }
            />
            <Label htmlFor={`project-${p.id}`} className="flex-1 font-normal">
              {p.name}
            </Label>
            {on && (
              <Label className="gap-2 text-xs font-normal text-muted-foreground">
                Approves production <Switch defaultChecked />
              </Label>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Access({ member, onClose }: { member: Member | null; onClose: () => void }) {
  return (
    <Dialog open={member !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{member?.name}&apos;s access</DialogTitle>
          <DialogDescription>Changes apply the next time they open a page.</DialogDescription>
        </DialogHeader>
        {member && (
          <>
            <Role value={member.role} />
            <ProjectAccess chosen={member.projects} />
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onClose}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Invite({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            They sign in with GitHub. The link works once and expires in 7 days.
          </DialogDescription>
        </DialogHeader>
        <Role value="Member" />
        <ProjectAccess chosen={['etherbit']} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-link">Invite link</Label>
          <div className="flex gap-2">
            <Input
              id="invite-link"
              readOnly
              value="dash.try.stationly.harshjv.com/join/R2VD-8KXP-3MTA"
              className="font-mono text-xs"
            />
            <Button variant="outline">
              <Link2 /> Copy
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Team() {
  return useLive() ? <LiveTeam /> : <MockTeam />
}

function MockTeam() {
  const [editing, setEditing] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [inviting, setInviting] = useState(false)
  const [gone, setGone] = useState<string[]>([])
  const shown = members.filter((m) => !gone.includes(m.handle))

  return (
    <Page title="Team">
      <Section
        title="People"
        count={shown.length}
        note="Everyone signs in with GitHub. Admins can see that a private task exists, never what is in it."
        action={
          <Button size="sm" onClick={() => setInviting(true)}>
            <UserPlus /> Invite
          </Button>
        }
      >
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Tasks this week</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((m) => (
                <TableRow key={m.handle}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="size-7">
                        <AvatarFallback className="text-xs">{m.name.slice(0, 1)}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <span>{m.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">@{m.handle}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.role}</TableCell>
                  <TableCell>
                    <Chips items={m.projects} />
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{m.tasks}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {m.active}
                  </TableCell>
                  <TableCell>
                    {m.handle !== 'harshjv' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${m.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(m)}>
                            Change access
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(m)}>
                            Remove from team…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section title="Invites waiting" count={invites.length}>
        <ItemList>
          {invites.map((i) => (
            <ItemRow
              key={i.code}
              icon={Link2}
              title={<span className="font-mono text-xs">…/join/{i.code}</span>}
              meta={[
                {
                  kind: 'project',
                  text: `${i.role} in ${i.project}`,
                },
                {
                  kind: 'user',
                  text: `by ${i.by}`,
                },
                {
                  kind: 'time',
                  text: `expires ${i.expires}`,
                },
              ]}
              action={
                <Button size="sm" variant="outline">
                  Revoke
                </Button>
              }
            />
          ))}
        </ItemList>
      </Section>

      <Access member={editing} onClose={() => setEditing(null)} />
      <Invite open={inviting} onOpenChange={setInviting} />

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name} from the team?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out everywhere, their assistants stop working and their running tasks
              stop. Their tasks, branches and approvals stay. Their private tasks become visible to
              admins, who can share or delete them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => removing && setGone([...gone, removing.handle])}
            >
              Remove {removing?.name}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
