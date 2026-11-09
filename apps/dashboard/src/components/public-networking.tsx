import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Cable, CircleAlert, Globe, Loader2, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy'
import { DomainsPanel } from '@/components/domains-panel'
import { Empty, ErrorState, Mono, Rows, Subsection } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, ApiFailure, failureText, idempotency, send } from '@/lib/api'
import type { Domain, PortAllocation, Service, ServicePort } from '@/lib/api'
import { allocationsQuery, domainsQuery, portsQuery, stationQuery } from '@/lib/queries'
import { toastStaged } from '@/lib/staged'
import { cn } from '@/lib/utils'

type Protocol = ServicePort['protocol']

type PortSpec = { port: number; protocol: Protocol; grpc: boolean }

type Dependent = { entity: string; id: string; hostname?: string; host_port?: number }

const specOf = (p: ServicePort): PortSpec => ({ port: p.port, protocol: p.protocol, grpc: p.grpc })

const protocolHelp: Record<Protocol, string> = {
  http: 'Reached through a domain on the Gateway, with TLS.',
  tcp: 'Reached on a host port of the station, byte for byte.'
}

function useInvalidateNetworking() {
  const client = useQueryClient()
  return () => {
    for (const key of ['ports', 'domains', 'port-allocations', 'services', 'deployments', 'network', 'staged']) void client.invalidateQueries({ queryKey: [key] })
  }
}

function usePortsChange(service: Service) {
  const navigate = useNavigate()
  const invalidate = useInvalidateNetworking()
  return useMutation({
    mutationFn: (input: { ports: PortSpec[]; done: string; staged: string }) => send(api.v1.services({ service: service.id }).patch({ ports: input.ports }, idempotency())),
    onSuccess: (result, input) => {
      invalidate()
      if (result.staged) {
        toastStaged(navigate, input.staged, result.body.id)
        return
      }
      const started = result.body.deployments[0]
      toast.success(input.done, { description: started ? `Deployment #${started.number} started to apply it.` : 'Saved.' })
      for (const warning of result.body.warnings) toast.warning(warning.code, { description: warning.explanation })
    }
  })
}

function FailureNotice({ error, allocations }: { error: unknown; allocations: PortAllocation[] }) {
  if (!(error instanceof ApiFailure)) return <ErrorState error={error} title="The change was refused" />
  const dependents = error.code === 'DELETE_HAS_DEPENDENTS' && Array.isArray(error.details.dependents) ? (error.details.dependents as Dependent[]) : []
  const addressOf = new Map(allocations.map(a => [a.id, a.address]))
  return (
    <Alert variant="destructive" data-testid="change-refused">
      <CircleAlert />
      <AlertTitle>
        {dependents.length > 0 ? 'Something still depends on this port' : 'The change was refused'}: {error.code}
      </AlertTitle>
      <AlertDescription className="space-y-2 text-foreground">
        <p>{error.message}</p>
        {dependents.length > 0 && (
          <ul className="space-y-1" aria-label="Dependents">
            {dependents.map(d => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                {d.entity === 'domain' ? <Globe className="size-4 text-muted-foreground" aria-hidden /> : <Cable className="size-4 text-muted-foreground" aria-hidden />}
                <span className="text-muted-foreground">{d.entity === 'domain' ? 'Domain' : 'TCP exposure'}</span>
                <Mono>{d.entity === 'domain' ? d.hostname : (addressOf.get(d.id) ?? `host port ${d.host_port}`)}</Mono>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">{dependents.length > 0 ? `${error.fix} Domains and TCP exposures are removed in their sections below.` : error.fix}</p>
      </AlertDescription>
    </Alert>
  )
}

function ProtocolChoice({ value, onChange, name }: { value: Protocol; onChange: (value: Protocol) => void; name: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Protocol</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['http', 'tcp'] as const).map(protocol => (
          <label
            key={protocol}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input type="radio" name={name} value={protocol} checked={value === protocol} onChange={() => onChange(protocol)} className="mt-0.5 accent-foreground" />
            <span>
              <span className="block font-medium">{protocol}</span>
              <span className="block text-xs text-muted-foreground">{protocolHelp[protocol]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function GrpcChoice({ id, checked, onChange }: { id: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={v => onChange(v === true)} className="mt-0.5" aria-describedby={`${id}-hint`} />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="font-normal">
          gRPC
        </Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          The port speaks HTTP/2 gRPC. It takes a direct domain or a TCP exposure, never a Tunnel.
        </p>
      </div>
    </div>
  )
}

function AddPort({ service, ports, allocations, open, onOpenChange }: { service: Service; ports: ServicePort[]; allocations: PortAllocation[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const change = usePortsChange(service)
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('http')
  const [grpc, setGrpc] = useState(false)
  const [taken, setTaken] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const number = Number(port)
    if (ports.some(p => p.port === number)) {
      setTaken(true)
      return
    }
    setTaken(false)
    change.mutate(
      { ports: [...ports.map(specOf), { port: number, protocol, grpc }], done: `Port ${number} added`, staged: `Adding port ${number} was staged for review` },
      { onSuccess: () => onOpenChange(false) }
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a port</DialogTitle>
            <DialogDescription>Sends the full port set to PATCH /v1/services/{'{service}'} and deploys {service.name}. sly and the update_service tool do the same.</DialogDescription>
          </DialogHeader>
          {change.isError && <FailureNotice error={change.error} allocations={allocations} />}
          <div className="space-y-1.5">
            <Label htmlFor="port-number">Port the container listens on</Label>
            <Input
              id="port-number"
              type="number"
              required
              min={1}
              max={65535}
              value={port}
              onChange={e => setPort(e.target.value)}
              className="w-32 font-mono"
              aria-invalid={taken || undefined}
              aria-describedby={taken ? 'port-number-taken' : undefined}
            />
            {taken && (
              <p id="port-number-taken" className="text-sm text-destructive" role="alert">
                {service.name} already has port {port}. Edit that port instead.
              </p>
            )}
          </div>
          <ProtocolChoice value={protocol} onChange={setProtocol} name="add-port-protocol" />
          <GrpcChoice id="add-port-grpc" checked={grpc} onChange={setGrpc} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={change.isPending || !port}>
              {change.isPending && <Loader2 className="animate-spin" />}
              Add port
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditPort({
  service,
  ports,
  allocations,
  target,
  initial,
  onClose
}: {
  service: Service
  ports: ServicePort[]
  allocations: PortAllocation[]
  target: ServicePort
  initial: Protocol
  onClose: () => void
}) {
  const change = usePortsChange(service)
  const [protocol, setProtocol] = useState<Protocol>(initial)
  const [grpc, setGrpc] = useState(target.grpc)
  const unchanged = protocol === target.protocol && grpc === target.grpc
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const what = protocol !== target.protocol ? `Port ${target.port} is now ${protocol}` : `Port ${target.port} ${grpc ? 'is marked gRPC' : 'is no longer gRPC'}`
    change.mutate({ ports: ports.map(p => (p.id === target.id ? { port: p.port, protocol, grpc } : specOf(p))), done: what, staged: `Changing port ${target.port} was staged for review` }, { onSuccess: onClose })
  }
  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Edit port {target.port}</DialogTitle>
            <DialogDescription>The port keeps its id; the change deploys {service.name}. A protocol change is refused while a domain or TCP exposure uses the port.</DialogDescription>
          </DialogHeader>
          {change.isError && <FailureNotice error={change.error} allocations={allocations} />}
          <ProtocolChoice value={protocol} onChange={setProtocol} name="edit-port-protocol" />
          <GrpcChoice id="edit-port-grpc" checked={grpc} onChange={setGrpc} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={change.isPending || unchanged}>
              {change.isPending && <Loader2 className="animate-spin" />}
              Save and deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemovePort({ service, ports, allocations, target }: { service: Service; ports: ServicePort[]; allocations: PortAllocation[]; target: ServicePort }) {
  const change = usePortsChange(service)
  const [open, setOpen] = useState(false)
  const last = ports.length === 1
  return (
    <AlertDialog
      open={open}
      onOpenChange={next => {
        if (!next) change.reset()
        setOpen(next)
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={last ? `Port ${target.port} is the only port and cannot be removed` : `Remove port ${target.port}`} disabled={last} title={last ? 'A web service needs at least one port' : undefined}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove port {target.port}?</AlertDialogTitle>
          <AlertDialogDescription>{service.name} deploys without it. Other services that reference this port stop reaching it.</AlertDialogDescription>
        </AlertDialogHeader>
        {change.isError && <FailureNotice error={change.error} allocations={allocations} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={change.isPending}
            onClick={event => {
              event.preventDefault()
              change.mutate(
                { ports: ports.filter(p => p.id !== target.id).map(specOf), done: `Port ${target.port} removed`, staged: `Removing port ${target.port} was staged for review` },
                { onSuccess: () => setOpen(false) }
              )
            }}
          >
            {change.isPending && <Loader2 className="animate-spin" />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Reach({ port, domains, allocations }: { port: ServicePort; domains: Domain[]; allocations: PortAllocation[] }) {
  if (port.protocol === 'http') {
    const mine = domains.filter(d => d.service_port_id === port.id)
    return <span className="text-xs text-muted-foreground">{mine.length ? mine.map(d => d.hostname).join(', ') : 'no domain yet'}</span>
  }
  const mine = allocations.filter(a => a.service_port_id === port.id)
  return <span className="text-xs text-muted-foreground">{mine.length ? mine.map(a => a.address ?? `host port ${a.host_port}`).join(', ') : 'not exposed'}</span>
}

type Editing = { port: ServicePort; protocol: Protocol }

function PortsPart({ service, ports, domains, allocations, onEdit }: { service: Service; ports: ServicePort[]; domains: Domain[]; allocations: PortAllocation[]; onEdit: (editing: Editing) => void }) {
  const [adding, setAdding] = useState(false)
  return (
    <Subsection
      title="Ports"
      description="What the container listens on. An http port takes domains; a tcp port takes a TCP exposure."
      actions={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add port
        </Button>
      }
    >
      <ul className="divide-y overflow-hidden rounded-lg border" aria-label={`Ports of ${service.name}`}>
        {ports.map(port => (
          <li key={port.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-card px-4 py-3" data-testid={`port-${port.port}`}>
            <Mono className="font-medium tabular-nums">{port.port}</Mono>
            <Badge variant="outline">{port.protocol}</Badge>
            {port.grpc && <Badge variant="secondary">gRPC</Badge>}
            <Reach port={port} domains={domains} allocations={allocations} />
            <span className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={`Edit port ${port.port}`} onClick={() => onEdit({ port, protocol: port.protocol })}>
                <Pencil />
              </Button>
              <RemovePort service={service} ports={ports} allocations={allocations} target={port} />
            </span>
          </li>
        ))}
      </ul>
      {adding && <AddPort service={service} ports={ports} allocations={allocations} open={adding} onOpenChange={setAdding} />}
    </Subsection>
  )
}

function NoPublicAddress({ station }: { station: { id: string; name: string } }) {
  const command = `sly stations update ${station.name} --public-address <ipv4>`
  return (
    <Alert data-testid="no-public-address" className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50">
      <TriangleAlert />
      <AlertTitle>NO_PUBLIC_ADDRESS: station {station.name} has no public address</AlertTitle>
      <AlertDescription className="space-y-2 text-current">
        <p>No direct domain or TCP exposure can reach it until the station has a public IPv4 address. Exposures keep their host port and answer once it is set.</p>
        <p className="flex flex-wrap items-center gap-1">
          Set it with <Mono className="rounded bg-background/60 px-1.5 py-0.5">{command}</Mono>
          <CopyButton value={command} label="command" />
        </p>
        <p className="text-xs opacity-80">
          The update_station tool and PATCH /v1/stations/{station.id} with public_address do the same; it reaches the station in the next generation.
        </p>
      </AlertDescription>
    </Alert>
  )
}

function AddressLine({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="font-medium">{address}</Mono>
      <CopyButton value={address} label={`address ${address}`} />
    </span>
  )
}

function Expose({ candidates, open, onOpenChange }: { candidates: ServicePort[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidateNetworking()
  const [port, setPort] = useState(candidates[0]?.id ?? '')
  const chosen = candidates.find(p => p.id === port) ?? candidates[0]
  const mutation = useMutation({
    mutationFn: (id: string) => send(api.v1.ports({ id })['port-allocations'].post(undefined, idempotency())),
    onSuccess: () => invalidate()
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (chosen) mutation.mutate(chosen.id)
  }
  const result = mutation.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {result ? (
          <div className="space-y-4" aria-live="polite">
            <DialogHeader>
              <DialogTitle>{result.staged ? 'The exposure was staged for review' : `Port ${chosen?.port} is exposed`}</DialogTitle>
              <DialogDescription>
                {result.staged ? 'This environment is protected; Dispatch allocates the host port when a human accepts the change.' : 'Clients on the internet connect to this address; the station forwards it to the container.'}
              </DialogDescription>
            </DialogHeader>
            {result.staged ? (
              <p className="text-sm">
                Staged change{' '}
                <Link to="/staged/$change" params={{ change: result.body.id }} className="font-mono underline underline-offset-4">
                  {result.body.id}
                </Link>
              </p>
            ) : result.body.address ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2" data-testid="exposed-address">
                <AddressLine address={result.body.address} />
              </div>
            ) : (
              <p className="text-sm" data-testid="exposed-address">
                Host port <Mono>{result.body.host_port}</Mono> is allocated. The station has no public address, so nothing reaches it yet.
              </p>
            )}
            <DialogFooter>
              {result.staged && (
                <Button asChild variant="outline">
                  <Link to="/staged/$change" params={{ change: result.body.id }}>
                    Review
                  </Link>
                </Button>
              )}
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Expose a tcp port</DialogTitle>
              <DialogDescription>Dispatch allocates a host port from exposure.port_range on the station. sly expose tcp and the expose_tcp tool do the same.</DialogDescription>
            </DialogHeader>
            {mutation.isError && <ErrorState error={mutation.error} title="The port was not exposed" />}
            <div className="space-y-1.5">
              <Label htmlFor="expose-port">Port</Label>
              <Select value={chosen?.id ?? ''} onValueChange={setPort}>
                <SelectTrigger id="expose-port" className="w-full">
                  <SelectValue placeholder="Choose a tcp port" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.port} (tcp{p.grpc ? ', gRPC' : ''})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!chosen || mutation.isPending}>
                {mutation.isPending && <Loader2 className="animate-spin" />}
                Expose
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RemoveExposure({ allocation, port }: { allocation: PortAllocation; port: number | undefined }) {
  const navigate = useNavigate()
  const invalidate = useInvalidateNetworking()
  const label = allocation.address ?? `host port ${allocation.host_port}`
  const mutation = useMutation({
    mutationFn: () => send(api.v1['port-allocations']({ id: allocation.id }).delete(undefined, idempotency())),
    onSuccess: result => {
      invalidate()
      if (result.staged) toastStaged(navigate, `Removing ${label} was staged for review`, result.body.id)
      else toast.success(`${label} removed`, { description: 'The station stops forwarding it in the next generation.' })
    },
    onError: failure => toast.error('The exposure was not removed', { description: failureText(failure) })
  })
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove exposure ${label}`}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
          <AlertDialogDescription>Clients connected through it are cut off{port ? ` and port ${port} is reachable only inside the environment` : ''}. Exposing the port again may allocate a different host port.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => mutation.mutate()}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ExposuresPart({
  ports,
  allocations,
  publicAddress,
  onEdit
}: {
  ports: ServicePort[]
  allocations: PortAllocation[]
  publicAddress: string | null | undefined
  onEdit: (editing: Editing) => void
}) {
  const [exposing, setExposing] = useState(false)
  const tcp = ports.filter(p => p.protocol === 'tcp')
  const exposed = new Set(allocations.map(a => a.service_port_id))
  const candidates = tcp.filter(p => !exposed.has(p.id))
  const portOf = new Map(ports.map(p => [p.id, p]))
  const http = ports.filter(p => p.protocol === 'http')
  return (
    <Subsection
      title="TCP exposures"
      description={publicAddress ? `Raw TCP from the internet on a host port of ${publicAddress}, for databases and other non-HTTP protocols.` : 'Raw TCP from the internet on a host port of the station, for databases and other non-HTTP protocols.'}
      actions={
        tcp.length > 0 && (
          <Button size="sm" onClick={() => setExposing(true)} disabled={candidates.length === 0} title={candidates.length === 0 ? 'Every tcp port is exposed' : undefined}>
            <Cable /> Expose tcp port
          </Button>
        )
      }
    >
      {tcp.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed px-4 py-4 text-sm" data-testid="http-only">
          <p>
            {http.length === 1 ? `Port ${http[0]!.port} is http` : 'Every port is http'}, and http ports are reached through a domain. A TCP exposure needs a tcp port: switch one if clients speak something other than HTTP, such as a database protocol.
          </p>
          <div className="flex flex-wrap gap-2">
            {http.map(p => (
              <Button key={p.id} size="sm" variant="outline" onClick={() => onEdit({ port: p, protocol: 'tcp' })}>
                Switch port {p.port} to tcp
              </Button>
            ))}
          </div>
        </div>
      ) : allocations.length === 0 ? (
        <Empty title="No TCP exposures">{`Expose ${tcp.map(p => p.port).join(', ')} to accept connections from outside the environment.`}</Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label="TCP exposures">
          {allocations.map(a => {
            const port = portOf.get(a.service_port_id)
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-card px-4 py-3" data-testid="exposure">
                <Cable className="size-4 text-muted-foreground" aria-hidden />
                {a.address ? <AddressLine address={a.address} /> : <span className="text-sm">host port <Mono>{a.host_port}</Mono>, no public address</span>}
                <span className="text-xs text-muted-foreground">→ port {port?.port ?? '?'}</span>
                <span className={cn('text-sm font-medium', a.status === 'active' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>{a.status}</span>
                <span className="ml-auto">
                  <RemoveExposure allocation={a} port={port?.port} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {exposing && <Expose candidates={candidates} open={exposing} onOpenChange={setExposing} />}
    </Subsection>
  )
}

export function PublicNetworking({ service, protectedEnvironment }: { service: Service; protectedEnvironment: boolean }) {
  const ports = useQuery(portsQuery(service.id))
  const domains = useQuery(domainsQuery(service.id))
  const allocations = useQuery(allocationsQuery(service.id))
  const station = useQuery(stationQuery(service.station_id))
  const [editing, setEditing] = useState<Editing | null>(null)
  const portList = ports.data?.items ?? []
  const allocationList = allocations.data?.items ?? []
  return (
    <section className="space-y-6" aria-labelledby="public-networking">
      <div className="space-y-1">
        <h2 id="public-networking" className="text-base font-semibold">
          Public networking
        </h2>
        <p className="text-sm text-muted-foreground">
          How the internet reaches {service.name}: http ports through domains, tcp ports through TCP exposures.
          {protectedEnvironment && ' This environment is protected, so every change here is staged for a human to review.'}
        </p>
      </div>
      {station.data && !station.data.public_address && <NoPublicAddress station={station.data} />}
      {service.kind !== 'web' ? (
        <Empty title="No public networking">A {service.kind} service takes no ports, so it has no domains or TCP exposures.</Empty>
      ) : ports.isPending || allocations.isPending ? (
        <Rows count={3} />
      ) : ports.isError ? (
        <ErrorState error={ports.error} title="Ports could not be read" />
      ) : allocations.isError ? (
        <ErrorState error={allocations.error} title="TCP exposures could not be read" />
      ) : (
        <>
          <PortsPart service={service} ports={portList} domains={domains.data?.items ?? []} allocations={allocationList} onEdit={setEditing} />
          <DomainsPanel service={service.id} />
          <ExposuresPart ports={portList} allocations={allocationList} publicAddress={station.data?.public_address} onEdit={setEditing} />
        </>
      )}
      {editing && <EditPort key={`${editing.port.id}:${editing.protocol}`} service={service} ports={portList} allocations={allocationList} target={editing.port} initial={editing.protocol} onClose={() => setEditing(null)} />}
    </section>
  )
}
