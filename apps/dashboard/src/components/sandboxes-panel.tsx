import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Loader2, Plus, ShieldCheck, TerminalSquare } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { DeleteSandbox, DeleteSnapshot, ExtendSandbox, ForkButton, StartSandbox, StopSandbox } from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { Empty, ErrorState, Mono, Rows, Section } from '@/components/page'
import { SandboxStatusBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import type { Environment } from '@/lib/api'
import { ago, bytes, slugPattern, slugTitle } from '@/lib/format'
import { sandboxesQuery, sandboxSnapshotsQuery } from '@/lib/queries'
import { imageText, parseAllowlist, parseDuration, ttlProblem } from '@/lib/sandbox'

const gib = 1024 ** 3

export function ProtectedNotice({ environment }: { environment: Environment }) {
  if (!environment.protected) return null
  return (
    <Alert>
      <ShieldCheck />
      <AlertTitle>Protected environment</AlertTitle>
      <AlertDescription>Sandbox changes here need a human. This dashboard session is one, so they apply at once; a token, an agent or an OAuth client is refused with PROTECTED_ENVIRONMENT.</AlertDescription>
    </Alert>
  )
}

export function EgressFields({ mode, onMode, domains, onDomains, idPrefix }: { mode: 'open' | 'allowlist'; onMode: (mode: 'open' | 'allowlist') => void; domains: string; onDomains: (text: string) => void; idPrefix: string }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-egress`}>Outbound traffic</Label>
        <Select value={mode} onValueChange={value => onMode(value as 'open' | 'allowlist')}>
          <SelectTrigger id={`${idPrefix}-egress`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open: any public destination</SelectItem>
            <SelectItem value="allowlist">Allowlist: only the domains below</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === 'allowlist' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-domains`}>Allowed domains</Label>
          <Textarea id={`${idPrefix}-domains`} rows={4} value={domains} onChange={e => onDomains(e.target.value)} placeholder={'registry.npmjs.org\n*.github.com:443'} className="font-mono" spellCheck={false} />
          <p className="text-xs text-muted-foreground">One per line or separated by spaces. Prefix a wildcard with *. and add ports after a colon, such as example.com:443,8443. Without ports, the default ports apply.</p>
        </div>
      )}
    </div>
  )
}

function NewSandbox({ environment, open, onOpenChange }: { environment: Environment; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [custom, setCustom] = useState(false)
  const [image, setImage] = useState('')
  const [network, setNetwork] = useState<'isolated' | 'environment'>('isolated')
  const [ttl, setTtl] = useState('1h')
  const [mode, setMode] = useState<'open' | 'allowlist'>('open')
  const [domains, setDomains] = useState('')
  const [cpu, setCpu] = useState('2')
  const [memory, setMemory] = useState('4')
  const [disk, setDisk] = useState('20')
  const [docker, setDocker] = useState(false)
  const [start, setStart] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (body: Parameters<ReturnType<typeof api.v1.environments>['sandboxes']['post']>[0]) => unwrap(api.v1.environments({ environment: environment.id }).sandboxes.post(body, idempotency())),
    onSuccess: created => {
      void client.invalidateQueries({ queryKey: ['sandboxes'] })
      toast.success(`${created.name} created`, { description: created.status === 'stopped' ? 'It is stopped; start it when you need it.' : 'It is starting.' })
      for (const warning of created.warnings) toast.warning(warning.code, { description: warning.explanation })
      onOpenChange(false)
      void navigate({ to: '/sandboxes/$sandbox', params: { sandbox: created.id } })
    },
    onError: failure => setError(failureText(failure))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const ttl_s = parseDuration(ttl)
    const problem = ttlProblem(ttl_s)
    if (problem || ttl_s === null) return setError(problem)
    const allowlist = parseAllowlist(domains)
    if (allowlist.problem) return setError(allowlist.problem)
    if (mode === 'allowlist' && allowlist.entries.length === 0) return setError('An allowlist needs at least one domain.')
    mutation.mutate({
      ...(name ? { name } : {}),
      ...(custom ? { image: { ref: image.trim() } } : {}),
      network,
      ttl_s,
      docker,
      start,
      egress: mode === 'open' ? { mode } : { mode, domains: allowlist.entries },
      size: { cpu_millis: Math.round(Number(cpu) * 1000), memory_bytes: Math.round(Number(memory) * gib), disk_bytes: Math.round(Number(disk) * gib) }
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>New sandbox</DialogTitle>
            <DialogDescription>A persistent machine for an agent or a person, isolated with gVisor. Its disk is kept while it is stopped.</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sbx-name">Name (optional)</Label>
              <Input id="sbx-name" value={name} onChange={e => setName(e.target.value)} pattern={slugPattern} title={slugTitle} placeholder="named for you if empty" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sbx-ttl">Time to live</Label>
              <Input id="sbx-ttl" required value={ttl} onChange={e => setTtl(e.target.value)} placeholder="1h" className="font-mono" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sbx-image">Image</Label>
              <Select value={custom ? 'custom' : 'toolchain'} onValueChange={value => setCustom(value === 'custom')}>
                <SelectTrigger id="sbx-image" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="toolchain">Toolchain (git, gh, Node, Python, Bun, Docker)</SelectItem>
                  <SelectItem value="custom">Another image</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sbx-network">Network</Label>
              <Select value={network} onValueChange={value => setNetwork(value as 'isolated' | 'environment')}>
                <SelectTrigger id="sbx-network" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="isolated">Isolated: public internet only</SelectItem>
                  <SelectItem value="environment">Environment: joins its private network</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {custom && (
            <div className="space-y-1.5">
              <Label htmlFor="sbx-ref">Image reference</Label>
              <Input id="sbx-ref" required value={image} onChange={e => setImage(e.target.value)} placeholder="docker.io/library/python:3.13" className="font-mono" />
            </div>
          )}
          <EgressFields mode={mode} onMode={setMode} domains={domains} onDomains={setDomains} idPrefix="sbx" />
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-medium">Resources</legend>
            <div className="space-y-1.5">
              <Label htmlFor="sbx-cpu" className="font-normal">
                vCPU
              </Label>
              <Input id="sbx-cpu" type="number" required min={0.1} step="any" value={cpu} onChange={e => setCpu(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sbx-memory" className="font-normal">
                Memory (GiB)
              </Label>
              <Input id="sbx-memory" type="number" required min={0.0625} step="any" value={memory} onChange={e => setMemory(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sbx-disk" className="font-normal">
                Disk (GiB)
              </Label>
              <Input id="sbx-disk" type="number" required min={1} step="any" value={disk} onChange={e => setDisk(e.target.value)} />
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Checkbox id="sbx-docker" checked={docker} onCheckedChange={v => setDocker(v === true)} />
              <Label htmlFor="sbx-docker" className="font-normal">
                Docker inside
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="sbx-start" checked={start} onCheckedChange={v => setStart(v === true)} />
              <Label htmlFor="sbx-start" className="font-normal">
                Start now
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Create sandbox
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const egressText = (egress: { mode: string; domains?: unknown[] | undefined }) => (egress.mode === 'open' ? 'open' : `allowlist (${egress.domains?.length ?? 0})`)

function SandboxTable({ environment }: { environment: Environment }) {
  const sandboxes = useQuery(sandboxesQuery(environment.id))
  if (sandboxes.isPending) return <Rows count={3} />
  if (sandboxes.isError) return <ErrorState error={sandboxes.error} />
  if (sandboxes.data.items.length === 0)
    return (
      <Empty title="No sandboxes in this environment">
        Create one with New sandbox, <Mono>sly sandbox create</Mono> or the create_sandbox MCP tool.
      </Empty>
    )
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sandbox</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden xl:table-cell">Image</TableHead>
            <TableHead className="hidden lg:table-cell">Resources</TableHead>
            <TableHead className="hidden md:table-cell">Network</TableHead>
            <TableHead className="hidden sm:table-cell">Time</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sandboxes.data.items.map(sandbox => {
            const idle = sandbox.status === 'stopped' || sandbox.status === 'failed'
            const live = sandbox.status === 'running' || sandbox.status === 'starting' || sandbox.status === 'creating'
            return (
              <TableRow key={sandbox.id} className="relative">
                <TableCell>
                  <Link to="/sandboxes/$sandbox" params={{ sandbox: sandbox.id }} className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none" data-testid="sandbox-link">
                    <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
                    {sandbox.name}
                    {sandbox.forked_from && (
                      <Badge variant="outline" className="font-normal">
                        fork
                      </Badge>
                    )}
                  </Link>
                  <span className="mt-0.5 block pl-6 text-xs sm:hidden">
                    <TimeLeft sandbox={sandbox} />
                  </span>
                </TableCell>
                <TableCell>
                  <SandboxStatusBadge status={sandbox.status} reason={sandbox.status_reason} />
                </TableCell>
                <TableCell className="hidden max-w-56 truncate xl:table-cell">
                  <Mono className="text-muted-foreground">{imageText(sandbox.image)}</Mono>
                </TableCell>
                <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
                  {sandbox.size.cpu_millis / 1000} vCPU · {bytes(sandbox.size.memory_bytes)}
                  <br />
                  <span className="text-xs">
                    disk {bytes(sandbox.disk_used_bytes)} of {bytes(sandbox.size.disk_bytes)}
                  </span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {sandbox.network}
                  <br />
                  <span className="text-xs">egress {egressText(sandbox.egress)}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <TimeLeft sandbox={sandbox} />
                </TableCell>
                <TableCell className="relative z-10 text-right">
                  <span className="inline-flex items-center gap-1">
                    {idle ? <StartSandbox sandbox={sandbox} size="icon-sm" /> : live ? <StopSandbox sandbox={sandbox} size="icon-sm" /> : null}
                    <ExtendSandbox sandbox={sandbox} size="icon-sm" />
                    <DeleteSandbox sandbox={sandbox} size="icon-sm" />
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function SnapshotTable({ environment, project }: { environment: Environment; project: string }) {
  const snapshots = useQuery(sandboxSnapshotsQuery(environment.id))
  const sandboxes = useQuery(sandboxesQuery(environment.id))
  const names = new Map((sandboxes.data?.items ?? []).map(s => [s.id, s.name]))
  if (snapshots.isPending) return <Rows count={2} />
  if (snapshots.isError) return <ErrorState error={snapshots.error} />
  if (snapshots.data.items.length === 0) return <Empty title="No snapshots">Take one from a sandbox page, with sly sandbox snapshot, or with the snapshot_sandbox MCP tool.</Empty>
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Snapshot</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="hidden sm:table-cell">Taken from</TableHead>
            <TableHead className="hidden md:table-cell">Size</TableHead>
            <TableHead className="hidden sm:table-cell">Taken</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshots.data.items.map(snapshot => (
            <TableRow key={snapshot.id}>
              <TableCell>
                <Mono className="font-medium">{snapshot.name ?? snapshot.id}</Mono>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{snapshot.status}</Badge>
              </TableCell>
              <TableCell className="hidden sm:table-cell">{names.get(snapshot.sandbox_id) ? <Mono>{names.get(snapshot.sandbox_id)}</Mono> : <span className="text-muted-foreground">deleted sandbox</span>}</TableCell>
              <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">{bytes(snapshot.referenced_bytes)}</TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">{ago(snapshot.taken_at)}</TableCell>
              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1">
                  {snapshot.status === 'ready' && <ForkButton source={{ kind: 'snapshot', snapshot }} project={project} environment={environment.name} iconOnly />}
                  <DeleteSnapshot snapshot={snapshot} />
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function SandboxesPanel({ environment, project }: { environment: Environment; project: string }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-6">
      <ProtectedNotice environment={environment} />
      <Section
        title="Sandboxes"
        description="Persistent machines for agents. A running sandbox stops at the end of its time to live and a stopped one is deleted after 7 days."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New sandbox
          </Button>
        }
      >
        <SandboxTable environment={environment} />
      </Section>
      <Section title="Snapshots" description="Read-only copies of a sandbox disk. Fork one to get a new sandbox.">
        <SnapshotTable environment={environment} project={project} />
      </Section>
      {creating && <NewSandbox environment={environment} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}
