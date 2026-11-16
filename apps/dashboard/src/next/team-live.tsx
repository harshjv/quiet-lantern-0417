import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, MoreHorizontal, UserPlus } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import { sessionQuery } from '@/lib/auth'
import { shortAgo } from '@/lib/format'
import { projectsQuery } from '@/lib/queries'

import { Notice, Page, Section } from './parts'

type Role = 'admin' | 'member'

type MemberRow = {
  user_id: string
  name: string
  email: string
  role: Role
  projects: string[]
  joined_at: string
  removed_at: string | null
}

const membersQuery = {
  queryKey: ['members'],
  queryFn: () => unwrap(api.v1.members.get()),
}

const invitesQuery = {
  queryKey: ['invites'],
  queryFn: () => unwrap(api.v1.invites.get()),
}

const roleText: Record<Role, { title: string; detail: string }> = {
  member: {
    title: 'Member',
    detail: 'Starts tasks in their projects and sees only their own tasks.',
  },
  admin: {
    title: 'Admin',
    detail: 'Everything, including servers, settings and the team.',
  },
}

function RolePicker({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <RadioGroup value={value} onValueChange={(next) => onChange(next as Role)}>
      {(['member', 'admin'] as const).map((role) => (
        <Label key={role} className="flex items-start gap-3 border p-3 font-normal">
          <RadioGroupItem value={role} className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{roleText[role].title}</span>
            <span className="text-xs text-muted-foreground">{roleText[role].detail}</span>
          </span>
        </Label>
      ))}
    </RadioGroup>
  )
}

function ProjectPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (projects: string[]) => void
}) {
  const { data } = useQuery(projectsQuery)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Projects</span>
      {(data?.items ?? []).map((p) => (
        <div key={p.id} className="flex items-center gap-3 border p-3">
          <Checkbox
            id={`project-${p.id}`}
            checked={value.includes(p.id)}
            onCheckedChange={(on) =>
              onChange(on ? [...value, p.id] : value.filter((id) => id !== p.id))
            }
          />
          <Label htmlFor={`project-${p.id}`} className="flex-1 font-normal">
            {p.name}
          </Label>
        </div>
      ))}
    </div>
  )
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const queries = useQueryClient()
  const [role, setRole] = useState<Role>('member')
  const [projects, setProjects] = useState<string[]>([])
  const [url, setUrl] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1.invites.post(
          {
            role,
            projects,
          },
          idempotency(),
        ),
      ),
    onSuccess: (invite) => {
      setUrl(invite.url ?? null)
      void queries.invalidateQueries({
        queryKey: ['invites'],
      })
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setUrl(null)
      setRole('member')
      setProjects([])
      create.reset()
    }

    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            The link works once and expires in 7 days. It is shown only now.
          </DialogDescription>
        </DialogHeader>
        {url ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-link">Invite link</Label>
            <div className="flex gap-2">
              <Input id="invite-link" readOnly value={url} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy the link"
                onClick={() => void navigator.clipboard.writeText(url)}
              >
                <Copy />
              </Button>
            </div>
          </div>
        ) : (
          <>
            <RolePicker value={role} onChange={setRole} />
            {role === 'member' && <ProjectPicker value={projects} onChange={setProjects} />}
            {create.error && (
              <Notice tone="danger" title="The invite was not created">
                {failureText(create.error)}
              </Notice>
            )}
          </>
        )}
        <DialogFooter>
          {url ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            <Button disabled={create.isPending} onClick={() => create.mutate()}>
              Create the link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccessDialog({ member, onClose }: { member: MemberRow | null; onClose: () => void }) {
  const queries = useQueryClient()
  const [role, setRole] = useState<Role>(member?.role ?? 'member')
  const [projects, setProjects] = useState<string[]>(member?.projects ?? [])
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1
          .members({
            user: member!.user_id,
          })
          .patch(
            {
              role,
              projects,
            },
            idempotency(),
          ),
      ),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['members'],
      })
      onClose()
    },
  })

  return (
    <Dialog open={member !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{member?.name}&apos;s access</DialogTitle>
          <DialogDescription>Changes apply to their next request.</DialogDescription>
        </DialogHeader>
        <RolePicker value={role} onChange={setRole} />
        {role === 'member' && <ProjectPicker value={projects} onChange={setProjects} />}
        {save.error && (
          <Notice tone="danger" title="Not saved">
            {failureText(save.error)}
          </Notice>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LiveTeam() {
  const queries = useQueryClient()
  const session = useQuery(sessionQuery)
  const members = useQuery(membersQuery)
  const me = members.data?.items.find((m) => m.user_id === session.data?.user.id)
  const admin = me?.role === 'admin'
  const invites = useQuery({
    ...invitesQuery,
    enabled: admin,
  })
  const projects = useQuery(projectsQuery)
  const projectName = (id: string) => projects.data?.items.find((p) => p.id === id)?.name ?? id
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<MemberRow | null>(null)
  const [removing, setRemoving] = useState<MemberRow | null>(null)
  const refresh = () => {
    void queries.invalidateQueries({
      queryKey: ['members'],
    })
    void queries.invalidateQueries({
      queryKey: ['invites'],
    })
  }
  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.v1
          .members({
            user: userId,
          })
          .delete(undefined, idempotency()),
      ),
    onSuccess: () => {
      setRemoving(null)
      refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.v1
          .invites({
            invite: id,
          })
          .delete(undefined, idempotency()),
      ),
    onSuccess: refresh,
  })
  const open = (invites.data?.items ?? []).filter((i) => i.status === 'open')

  return (
    <Page
      title="Team"
      actions={
        admin ? (
          <Button onClick={() => setInviting(true)}>
            <UserPlus /> Invite someone
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        Admins see every project and task. A member works only in their projects and sees only their
        own tasks.
      </p>
      <Section title="Members">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Projects</TableHead>
              <TableHead>Joined</TableHead>
              {admin && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(members.data?.items ?? []).map((m) => (
              <TableRow key={m.user_id} className={m.removed_at ? 'opacity-50' : undefined}>
                <TableCell>
                  <span className="flex flex-col">
                    <span>{m.name || m.email}</span>
                    <span className="text-xs text-muted-foreground">{m.email}</span>
                  </span>
                </TableCell>
                <TableCell>{m.removed_at ? 'Removed' : roleText[m.role].title}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {m.role === 'admin' ? 'All' : m.projects.map(projectName).join(', ') || 'None'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {shortAgo(m.joined_at)}
                </TableCell>
                {admin && (
                  <TableCell>
                    {!m.removed_at && m.user_id !== me?.user_id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${m.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing(m)}>
                            Change access
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setRemoving(m)}
                          >
                            Remove from the team
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
      {admin && (
        <Section title="Open invites">
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open invites.</p>
          ) : (
            <Table>
              <TableBody>
                {open.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{roleText[i.role].title}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {i.projects.map(projectName).join(', ') ||
                        (i.role === 'admin' ? 'All' : 'None')}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      Expires {new Date(i.expires_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(i.id)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      )}
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      {editing && <AccessDialog member={editing} onClose={() => setEditing(null)} />}
      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name} from the team?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out everywhere and their running tasks stop. Their tasks and branches
              stay, for an admin to keep or delete.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error && (
            <Notice tone="danger" title="Not removed">
              {failureText(remove.error)}
            </Notice>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault()

                if (removing) {
                  remove.mutate(removing.user_id)
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
