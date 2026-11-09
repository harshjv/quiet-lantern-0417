import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Camera, CircleAlert, GitFork, Loader2, Play, Square, Timer, Trash2 } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiFailure, api, failureText, idempotency, unwrap } from '@/lib/api'
import type { Sandbox, SandboxSnapshot } from '@/lib/api'
import { formatSpan, parseDuration, ttlProblem } from '@/lib/sandbox'
import { slugPattern, slugTitle } from '@/lib/format'

type Named = Pick<Sandbox, 'id' | 'name' | 'status'> & { environment_id: string }

const useRefresh = () => {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: ['sandboxes'] })
    void client.invalidateQueries({ queryKey: ['sandbox-snapshots'] })
  }
}

const reportFailure = (title: string) => (failure: unknown) =>
  toast.error(title, { description: failure instanceof ApiFailure ? `${failure.code}: ${failure.message} ${failure.fix}` : failureText(failure) })

export function StartSandbox({ sandbox, size = 'sm' }: { sandbox: Named; size?: 'sm' | 'icon-sm' }) {
  const refresh = useRefresh()
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).start.post(undefined, idempotency())),
    onSuccess: () => {
      toast.success(`${sandbox.name} is starting`)
      refresh()
    },
    onError: reportFailure(`${sandbox.name} was not started`)
  })
  return (
    <Button variant="outline" size={size} disabled={mutation.isPending} onClick={() => mutation.mutate()} aria-label={size === 'icon-sm' ? `Start ${sandbox.name}` : undefined}>
      {mutation.isPending ? <Loader2 className="animate-spin" /> : <Play />}
      {size === 'sm' && 'Start'}
    </Button>
  )
}

export function StopSandbox({ sandbox, size = 'sm' }: { sandbox: Named; size?: 'sm' | 'icon-sm' }) {
  const refresh = useRefresh()
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).stop.post(undefined, idempotency())),
    onSuccess: () => {
      toast.success(`${sandbox.name} is stopping`, { description: 'Its disk is kept.' })
      refresh()
    },
    onError: reportFailure(`${sandbox.name} was not stopped`)
  })
  return (
    <Button variant="outline" size={size} disabled={mutation.isPending} onClick={() => mutation.mutate()} aria-label={size === 'icon-sm' ? `Stop ${sandbox.name}` : undefined}>
      {mutation.isPending ? <Loader2 className="animate-spin" /> : <Square />}
      {size === 'sm' && 'Stop'}
    </Button>
  )
}

const presets = ['30m', '1h', '4h', '12h', '1d']

export function ExtendSandbox({ sandbox, size = 'sm' }: { sandbox: Named & Pick<Sandbox, 'ttl_s'>; size?: 'sm' | 'icon-sm' }) {
  const refresh = useRefresh()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('1h')
  const [error, setError] = useState<string | null>(null)
  const seconds = parseDuration(text)
  const stopped = sandbox.status === 'stopped' || sandbox.status === 'failed'
  const mutation = useMutation({
    mutationFn: (ttl_s: number) => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).patch({ ttl_s }, idempotency())),
    onSuccess: () => {
      toast.success(`${sandbox.name} runs for ${formatSpan(seconds ?? 0)} from now`)
      refresh()
      setOpen(false)
    },
    onError: failure => setError(failureText(failure))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = ttlProblem(seconds)
    if (problem || seconds === null) return setError(problem)
    setError(null)
    mutation.mutate(seconds)
  }
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)} aria-label={size === 'icon-sm' ? `Extend ${sandbox.name}` : undefined} disabled={stopped}>
        <Timer />
        {size === 'sm' && 'Extend'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Extend {sandbox.name}</DialogTitle>
              <DialogDescription>The sandbox stops this long from now, whatever time was left. It currently has a time to live of {formatSpan(sandbox.ttl_s)}.</DialogDescription>
            </DialogHeader>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="extend-ttl">Time to live</Label>
              <Input id="extend-ttl" value={text} onChange={e => setText(e.target.value)} className="font-mono" autoComplete="off" />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {presets.map(preset => (
                  <Button key={preset} type="button" size="xs" variant={text === preset ? 'secondary' : 'outline'} onClick={() => setText(preset)}>
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="animate-spin" />}
                Extend
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

export const CopiedFilesNotice = () => (
  <p className="flex items-start gap-2 text-sm text-muted-foreground">
    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
    Files on the disk, credentials included, are copied into every snapshot and fork.
  </p>
)

export function SnapshotSandbox({ sandbox }: { sandbox: Named }) {
  const refresh = useRefresh()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).snapshots.post(name ? { name } : {}, idempotency())),
    onSuccess: snapshot => {
      toast.success(`Snapshot ${snapshot.name ?? snapshot.id} is ${snapshot.status}`)
      for (const warning of snapshot.warnings) toast.warning(warning.code, { description: warning.explanation })
      refresh()
      setOpen(false)
      setName('')
    },
    onError: failure => setError(failureText(failure))
  })
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={sandbox.status === 'creating' || sandbox.status === 'deleting'}>
        <Camera /> Snapshot
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={event => {
              event.preventDefault()
              setError(null)
              mutation.mutate()
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Snapshot {sandbox.name}</DialogTitle>
              <DialogDescription>A read-only copy of the disk. A running sandbox is copied as it is, so data still in process buffers is not in it.</DialogDescription>
            </DialogHeader>
            <CopiedFilesNotice />
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="snapshot-name">Name (optional)</Label>
              <Input id="snapshot-name" value={name} onChange={e => setName(e.target.value)} pattern={slugPattern} title={slugTitle} className="font-mono" autoComplete="off" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="animate-spin" />}
                Take snapshot
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

type ForkSource = { kind: 'sandbox'; sandbox: Named } | { kind: 'snapshot'; snapshot: SandboxSnapshot }

export function ForkButton({ source, project, environment, label = 'Fork', iconOnly = false }: { source: ForkSource; project: string; environment: string; label?: string; iconOnly?: boolean }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const from = source.kind === 'sandbox' ? { sandbox: source.sandbox.id } : { snapshot: source.snapshot.id }
  const environmentId = source.kind === 'sandbox' ? source.sandbox.environment_id : source.snapshot.environment_id
  const subject = source.kind === 'sandbox' ? source.sandbox.name : (source.snapshot.name ?? source.snapshot.id)
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.environments({ environment: environmentId }).sandboxes.post({ from, ...(name ? { name } : {}) }, idempotency())),
    onSuccess: created => {
      toast.success(`${created.name} forked from ${subject}`)
      for (const warning of created.warnings) toast.warning(warning.code, { description: warning.explanation })
      void client.invalidateQueries({ queryKey: ['sandboxes'] })
      setOpen(false)
      setName('')
      void navigate({ to: '/sandboxes/$sandbox', params: { sandbox: created.id } })
    },
    onError: failure => setError(failureText(failure))
  })
  return (
    <>
      <Button variant="outline" size={iconOnly ? 'icon-sm' : 'sm'} onClick={() => setOpen(true)} aria-label={iconOnly ? `${label} ${subject}` : undefined}>
        <GitFork />
        {!iconOnly && label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={event => {
              event.preventDefault()
              setError(null)
              mutation.mutate()
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Fork {subject}</DialogTitle>
              <DialogDescription>
                {source.kind === 'sandbox' ? 'A new sandbox on a copy of the live disk, in' : 'A new sandbox on a copy of the snapshot, in'} {project}/{environment}, with the source's size, network and egress.
              </DialogDescription>
            </DialogHeader>
            <CopiedFilesNotice />
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="fork-name">Name (optional)</Label>
              <Input id="fork-name" value={name} onChange={e => setName(e.target.value)} pattern={slugPattern} title={slugTitle} className="font-mono" autoComplete="off" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="animate-spin" />}
                Fork
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Confirm({ title, description, action, onConfirm, trigger }: { title: string; description: ReactNode; action: string; onConfirm: () => void; trigger: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {trigger(() => setOpen(true))}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              {action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function DeleteSandbox({ sandbox, size = 'sm', after }: { sandbox: Named; size?: 'sm' | 'icon-sm'; after?: () => void }) {
  const refresh = useRefresh()
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).delete(undefined, idempotency())),
    onSuccess: result => {
      toast.success(`${sandbox.name} deleted`, { description: result.snapshots_kept ? `${result.snapshots_kept} snapshot${result.snapshots_kept === 1 ? '' : 's'} kept.` : undefined })
      refresh()
      after?.()
    },
    onError: reportFailure(`${sandbox.name} was not deleted`)
  })
  return (
    <Confirm
      title={`Delete ${sandbox.name}?`}
      description="The sandbox and its disk are removed. Snapshots taken from it stay."
      action="Delete"
      onConfirm={() => mutation.mutate()}
      trigger={open => (
        <Button variant="outline" size={size} onClick={open} disabled={mutation.isPending || sandbox.status === 'deleting'} aria-label={size === 'icon-sm' ? `Delete ${sandbox.name}` : undefined}>
          <Trash2 />
          {size === 'sm' && 'Delete'}
        </Button>
      )}
    />
  )
}

export function DeleteSnapshot({ snapshot }: { snapshot: SandboxSnapshot }) {
  const refresh = useRefresh()
  const label = snapshot.name ?? snapshot.id
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1['sandbox-snapshots']({ id: snapshot.id }).delete(undefined, idempotency())),
    onSuccess: () => {
      toast.success(`Snapshot ${label} deleted`)
      refresh()
    },
    onError: reportFailure(`Snapshot ${label} was not deleted`)
  })
  return (
    <Confirm
      title={`Delete snapshot ${label}?`}
      description="Sandboxes already forked from it keep their own disks."
      action="Delete"
      onConfirm={() => mutation.mutate()}
      trigger={open => (
        <Button variant="outline" size="icon-sm" onClick={open} disabled={mutation.isPending || snapshot.status === 'deleting'} aria-label={`Delete snapshot ${label}`}>
          <Trash2 />
        </Button>
      )}
    />
  )
}
