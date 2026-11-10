import { useMutation, useQuery, useSuspenseQueries } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Cable, CircleAlert, Globe, Pencil, Plus, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith, Code, CommandBlock } from '@/components/code'
import { Confirm, RemoveButton } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { DomainsPanel } from '@/components/domains-panel'
import { CheckboxField, Field } from '@/components/field'
import { DialogForm, dialogScroll, FormDialog, FormError } from '@/components/form-dialog'
import { EmptyState, ErrorState, Subsection } from '@/components/page'
import { Panel } from '@/components/panel'
import { Term } from '@/components/term'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  api,
  ApiFailure,
  idempotency,
  send,
  type Domain,
  type PortAllocation,
  type Service,
  type ServicePort,
} from '@/lib/api'
import { editItems } from '@/lib/cache'
import { commands, type ServiceScope } from '@/lib/commands'
import { useInvalidate } from '@/lib/invalidate'
import { serviceKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  allocationsQuery,
  domainsQuery,
  portsQuery,
  seedService,
  stationQuery,
} from '@/lib/queries'
import { stagedText, stagedTitle } from '@/lib/staged'
import { toneText, warningAlert } from '@/lib/tone'
import { useEnvironmentTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

type Protocol = ServicePort['protocol']

type PortSpec = { port: number; protocol: Protocol; grpc: boolean }

type Dependent = { entity: string; id: string; hostname?: string; host_port?: number }

const specOf = (p: ServicePort): PortSpec => ({
  port: p.port,
  protocol: p.protocol,
  grpc: p.grpc,
})

const protocolHelp: Record<Protocol, string> = {
  http: 'Reachable through a domain with HTTPS.',
  tcp: 'Reachable on a public port of the station, for databases and other protocols.',
}

type PortsChange = { ports: PortSpec[]; done: string; staged: string }

const portsFailed = 'Couldn’t save the ports'

function usePortsChange(service: Service) {
  return useApiMutation({
    mutationFn: (input: PortsChange) =>
      send(
        api.v1
          .services({
            service: service.id,
          })
          .patch(
            {
              ports: input.ports,
            },
            idempotency(),
          ),
      ),
    optimistic: (input) => [
      editItems(portsQuery(service.id), (ports) =>
        ports.map((p) => {
          const spec = input.ports.find((next) => next.port === p.port)
          return spec
            ? {
                ...p,
                protocol: spec.protocol,
                grpc: spec.grpc,
              }
            : p
        }),
      ),
    ],
    seed: seedService,
    invalidate: ['networking'],
    staged: (input) => input.staged,
    success: (body, input) => {
      const started = body.deployments[0]
      return {
        title: input.done,
        description: started ? `Deployment #${started.number} is rolling it out.` : undefined,
      }
    },
  })
}

function FailureNotice({
  error,
  allocations,
  title = portsFailed,
}: {
  error: unknown
  allocations: PortAllocation[]
  title?: string
}) {
  if (!(error instanceof ApiFailure)) return <ErrorState error={error} title={title} />
  const dependents =
    error.code === 'DELETE_HAS_DEPENDENTS' && Array.isArray(error.details.dependents)
      ? (error.details.dependents as Dependent[])
      : []
  if (dependents.length === 0) return <ErrorState error={error} title={title} />
  const addressOf = new Map(allocations.map((a) => [a.id, a.address]))
  return (
    <Alert variant="destructive" data-testid="change-refused">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2 text-foreground">
        <p className="text-muted-foreground">{error.message}</p>
        <p>These still use the port:</p>
        <ul className="space-y-1" aria-label="Still using the port">
          {dependents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              {d.entity === 'domain' ? (
                <Globe className="size-4 text-muted-foreground" aria-hidden />
              ) : (
                <Cable className="size-4 text-muted-foreground" aria-hidden />
              )}
              <span className="text-muted-foreground">
                {d.entity === 'domain' ? 'Domain' : 'Public TCP port'}
              </span>
              <Code>
                {d.entity === 'domain'
                  ? d.hostname
                  : (addressOf.get(d.id) ?? `port ${d.host_port}`)}
              </Code>
            </li>
          ))}
        </ul>
        <p>{error.fix} Remove them in their sections below.</p>
      </AlertDescription>
    </Alert>
  )
}

const protocolOptions = (['http', 'tcp'] as const).map((protocol) => ({
  value: protocol,
  title: protocol.toUpperCase(),
  hint: protocolHelp[protocol],
}))

function ProtocolChoice({
  value,
  onChange,
  name,
}: {
  value: Protocol
  onChange: (value: Protocol) => void
  name: string
}) {
  return (
    <ChoiceCards
      name={name}
      legend="Protocol"
      value={value}
      onChange={onChange}
      options={protocolOptions}
      className="grid-cols-1 sm:grid-cols-2"
    />
  )
}

function GrpcChoice({
  id,
  checked,
  onChange,
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <CheckboxField
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      label="gRPC"
      hint="This port speaks gRPC over HTTP/2. Give it a domain or a public TCP port."
    />
  )
}

function AddPort({
  service,
  ports,
  allocations,
  open,
  onOpenChange,
}: {
  service: Service
  ports: ServicePort[]
  allocations: PortAllocation[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const change = usePortsChange(service)
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('http')
  const [grpc, setGrpc] = useState(false)
  const [taken, setTaken] = useState(false)
  const submit = () => {
    const number = Number(port)
    if (ports.some((p) => p.port === number)) {
      setTaken(true)
      return
    }
    setTaken(false)
    change.mutate(
      {
        ports: [
          ...ports.map(specOf),
          {
            port: number,
            protocol,
            grpc,
          },
        ],
        done: `Port ${number} added`,
        staged: `Add port ${number} to ${service.name}`,
      },
      {
        onSuccess: () => onOpenChange(false),
      },
    )
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a port"
      description={`Adding a port deploys ${service.name}.`}
      error={change.isError && <FailureNotice error={change.error} allocations={allocations} />}
      submitLabel="Add port"
      pending={change.isPending}
      submitDisabled={!port}
      onSubmit={submit}
    >
      <Field id="port-number" label="Port the container listens on">
        <Input
          id="port-number"
          type="number"
          required
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="w-32 font-mono"
          aria-invalid={taken || undefined}
          aria-describedby={taken ? 'port-number-taken' : undefined}
        />
        {taken && (
          <FormError id="port-number-taken">
            {service.name} already has port {port}. Edit that port instead.
          </FormError>
        )}
      </Field>
      <ProtocolChoice value={protocol} onChange={setProtocol} name="add-port-protocol" />
      <GrpcChoice id="add-port-grpc" checked={grpc} onChange={setGrpc} />
    </FormDialog>
  )
}

function EditPort({
  service,
  ports,
  allocations,
  target,
  initial,
  onClose,
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
  const submit = () => {
    const what =
      protocol !== target.protocol
        ? `Port ${target.port} is now ${protocol.toUpperCase()}`
        : `Port ${target.port} ${grpc ? 'now speaks gRPC' : 'no longer speaks gRPC'}`
    change.mutate(
      {
        ports: ports.map((p) =>
          p.id === target.id
            ? {
                port: p.port,
                protocol,
                grpc,
              }
            : specOf(p),
        ),
        done: what,
        staged: `Change port ${target.port} of ${service.name}`,
      },
      {
        onSuccess: onClose,
      },
    )
  }
  return (
    <FormDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Edit port ${target.port}`}
      description={`Saving deploys ${service.name}. You can’t change the protocol while a domain or public TCP port uses this port.`}
      error={change.isError && <FailureNotice error={change.error} allocations={allocations} />}
      submitLabel="Save and deploy"
      pending={change.isPending}
      hideWhilePending
      submitDisabled={unchanged}
      onSubmit={submit}
    >
      <ProtocolChoice value={protocol} onChange={setProtocol} name="edit-port-protocol" />
      <GrpcChoice id="edit-port-grpc" checked={grpc} onChange={setGrpc} />
    </FormDialog>
  )
}

function RemovePort({
  service,
  ports,
  allocations,
  target,
}: {
  service: Service
  ports: ServicePort[]
  allocations: PortAllocation[]
  target: ServicePort
}) {
  const change = usePortsChange(service)
  const last = ports.length === 1
  return (
    <Confirm
      title={`Remove port ${target.port}?`}
      description={`Removing it deploys ${service.name}. Other services that call this port lose their connection.`}
      action="Remove port"
      cancel="Keep port"
      renderError={(failure) => (
        <FailureNotice
          error={failure}
          allocations={allocations}
          title={`Couldn’t remove port ${target.port}`}
        />
      )}
      onConfirm={() =>
        change.mutateAsync({
          ports: ports.filter((p) => p.id !== target.id).map(specOf),
          done: `Port ${target.port} removed`,
          staged: `Remove port ${target.port} from ${service.name}`,
        })
      }
      trigger={
        <RemoveButton
          label={
            last
              ? `You can’t remove port ${target.port}, the only port`
              : `Remove port ${target.port}`
          }
          disabled={last}
          title={last ? 'A web service needs at least one port.' : undefined}
        />
      }
    />
  )
}

function Reach({
  port,
  domains,
  allocations,
}: {
  port: ServicePort
  domains: Domain[]
  allocations: PortAllocation[]
}) {
  if (port.protocol === 'http') {
    const mine = domains.filter((d) => d.service_port_id === port.id)
    return (
      <span className="text-xs text-muted-foreground">
        {mine.length ? mine.map((d) => d.hostname).join(', ') : 'No domain yet'}
      </span>
    )
  }
  const mine = allocations.filter((a) => a.service_port_id === port.id)
  return (
    <span className="text-xs text-muted-foreground">
      {mine.length ? mine.map((a) => a.address ?? `port ${a.host_port}`).join(', ') : 'Not public'}
    </span>
  )
}

type Editing = { port: ServicePort; protocol: Protocol }

function PortsPart({
  service,
  ports,
  domains,
  allocations,
  onEdit,
}: {
  service: Service
  ports: ServicePort[]
  domains: Domain[]
  allocations: PortAllocation[]
  onEdit: (editing: Editing) => void
}) {
  const [adding, setAdding] = useState(false)
  return (
    <Subsection
      title="Ports"
      description="What the container listens on. HTTP ports can have a domain. TCP ports can get a public port."
      actions={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add port
        </Button>
      }
    >
      <ul
        className="divide-y overflow-hidden rounded-lg border"
        aria-label={`Ports of ${service.name}`}
      >
        {ports.map((port) => (
          <li
            key={port.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-card px-4 py-3"
            data-testid={`port-${port.port}`}
          >
            <span className="font-mono text-sm font-medium tabular-nums">{port.port}</span>
            <Badge variant="outline">{port.protocol.toUpperCase()}</Badge>
            {port.grpc && <Badge variant="secondary">gRPC</Badge>}
            <Reach port={port} domains={domains} allocations={allocations} />
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit port ${port.port}`}
                onClick={() =>
                  onEdit({
                    port,
                    protocol: port.protocol,
                  })
                }
              >
                <Pencil />
              </Button>
              <RemovePort service={service} ports={ports} allocations={allocations} target={port} />
            </span>
          </li>
        ))}
      </ul>
      {adding && (
        <AddPort
          service={service}
          ports={ports}
          allocations={allocations}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
    </Subsection>
  )
}

function NoPublicAddress({ station, service }: { station: { name: string }; service: string }) {
  return (
    <Alert data-testid="no-public-address" className={warningAlert}>
      <TriangleAlert />
      <AlertTitle>Station {station.name} has no public address</AlertTitle>
      <AlertDescription className="space-y-3 text-current">
        <p>
          Domains and public TCP ports can’t reach {service} until you set one. Ports you expose now
          keep their number.
        </p>
        <CommandBlock
          commands={commands.setPublicAddress(station.name)}
          caption="Run on your computer"
          className="bg-background/70"
        />
        <AlsoWith tool="update_station" className="justify-start" />
      </AlertDescription>
    </Alert>
  )
}

function AddressLine({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-sm font-medium">{address}</span>
      <CopyButton value={address} label={`address ${address}`} />
    </span>
  )
}

function Expose({
  scope,
  candidates,
  open,
  onOpenChange,
}: {
  scope: ServiceScope
  candidates: ServicePort[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidate()
  const [port, setPort] = useState(candidates[0]?.id ?? '')
  const chosen = candidates.find((p) => p.id === port) ?? candidates[0]
  const mutation = useMutation({
    mutationFn: (id: string) =>
      send(
        api.v1
          .ports({
            id,
          })
          ['port-allocations'].post(undefined, idempotency()),
      ),
    onSuccess: () => invalidate('networking', 'staged'),
  })
  const result = mutation.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogScroll}>
        {result ? (
          <div className="space-y-4" aria-live="polite">
            <DialogHeader>
              <DialogTitle>
                {result.staged ? stagedTitle : `Port ${chosen?.port} is public`}
              </DialogTitle>
              <DialogDescription>
                {result.staged
                  ? stagedText(`Expose port ${chosen?.port} of ${scope.service}`)
                  : 'Clients on the internet connect to this address. The station forwards it to the container.'}
              </DialogDescription>
            </DialogHeader>
            {result.staged ? null : result.body.address ? (
              <div
                className="rounded-md border bg-muted/40 px-3 py-2"
                data-testid="exposed-address"
              >
                <AddressLine address={result.body.address} />
              </div>
            ) : (
              <p className="text-sm" data-testid="exposed-address">
                Stationly reserved port <Code>{result.body.host_port}</Code>. The station has no
                public address, so nothing reaches it yet.
              </p>
            )}
            <DialogFooter>
              {result.staged && (
                <Button asChild variant="outline">
                  <Link
                    to="/staged/$change"
                    params={{
                      change: result.body.id,
                    }}
                  >
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
          <DialogForm
            title="Expose a TCP port"
            description="Stationly picks a free port on the station and forwards it to the port you choose."
            error={
              mutation.isError && (
                <ErrorState error={mutation.error} title={`Couldn’t expose port ${chosen?.port}`} />
              )
            }
            also={
              <AlsoWith cli={commands.exposeTcp(scope, chosen?.port ?? null)} tool="expose_tcp" />
            }
            submitLabel="Expose port"
            pending={mutation.isPending}
            submitDisabled={!chosen}
            onSubmit={() => chosen && mutation.mutate(chosen.id)}
            onCancel={() => onOpenChange(false)}
          >
            <Field id="expose-port" label="Port">
              <Select value={chosen?.id ?? ''} onValueChange={setPort}>
                <SelectTrigger id="expose-port" className="w-full">
                  <SelectValue placeholder="Choose a TCP port" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.port} TCP{p.grpc ? ', gRPC' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RemoveExposure({
  allocation,
  port,
}: {
  allocation: PortAllocation
  port: number | undefined
}) {
  const label = allocation.address ?? `Public port ${allocation.host_port}`
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1['port-allocations']({
          id: allocation.id,
        }).delete(undefined, idempotency()),
      ),
    invalidate: ['networking'],
    staged: () => `Remove ${label}`,
    success: () => ({
      title: `${label} removed`,
      description: 'The station stops forwarding it within a few seconds.',
    }),
  })
  return (
    <Confirm
      title={`Remove ${label}?`}
      description={`Clients connected through it lose their connection${port ? `, and port ${port} stays reachable inside the environment only` : ''}. If you expose it again, it may get a different number.`}
      action="Remove port"
      cancel="Keep port"
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${label}`} />}
    />
  )
}

function ExposuresPart({
  scope,
  ports,
  allocations,
  publicAddress,
  onEdit,
}: {
  scope: ServiceScope
  ports: ServicePort[]
  allocations: PortAllocation[]
  publicAddress: string | null | undefined
  onEdit: (editing: Editing) => void
}) {
  const [exposing, setExposing] = useState(false)
  const tcp = ports.filter((p) => p.protocol === 'tcp')
  const exposed = new Set(allocations.map((a) => a.service_port_id))
  const candidates = tcp.filter((p) => !exposed.has(p.id))
  const portOf = new Map(ports.map((p) => [p.id, p]))
  const http = ports.filter((p) => p.protocol === 'http')
  return (
    <Subsection
      title={<Term name="publicTcpPort">Public TCP ports</Term>}
      description={`TCP from the internet on a port of ${publicAddress ?? 'the station'}, for databases and other protocols.`}
      actions={
        tcp.length > 0 &&
        allocations.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setExposing(true)}
            disabled={candidates.length === 0}
            title={candidates.length === 0 ? 'All TCP ports are public.' : undefined}
          >
            <Cable /> Expose port
          </Button>
        )
      }
    >
      {tcp.length === 0 ? (
        <div
          className="space-y-3 rounded-lg border border-dashed px-4 py-4 text-sm"
          data-testid="http-only"
        >
          <p>
            {http.length === 1 ? `Port ${http[0]!.port} is HTTP` : 'All ports are HTTP'}. HTTP ports
            take a domain. Switch a port to TCP if its clients speak another protocol, such as a
            database.
          </p>
          <div className="flex flex-wrap gap-2">
            {http.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="outline"
                onClick={() =>
                  onEdit({
                    port: p,
                    protocol: 'tcp',
                  })
                }
              >
                Switch port {p.port} to TCP
              </Button>
            ))}
          </div>
        </div>
      ) : allocations.length === 0 ? (
        <EmptyState
          icon={Cable}
          title="No public TCP ports yet"
          description="A public TCP port lets clients outside the environment connect to a TCP port of this service."
          action={
            <Button size="sm" onClick={() => setExposing(true)}>
              <Cable /> Expose port {candidates[0]?.port}
            </Button>
          }
          also={
            <AlsoWith
              cli={commands.exposeTcp(scope, candidates[0]?.port ?? null)}
              tool="expose_tcp"
            />
          }
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Public TCP ports">
          {allocations.map((a) => {
            const port = portOf.get(a.service_port_id)
            return (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-card px-4 py-3"
                data-testid="exposure"
              >
                <Cable className="size-4 text-muted-foreground" aria-hidden />
                {a.address ? (
                  <AddressLine address={a.address} />
                ) : (
                  <span className="text-sm">
                    Port <Code>{a.host_port}</Code> on the station, no public address yet
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  to port {port?.port ?? 'unknown'}
                </span>
                <span
                  className={cn(
                    'text-sm font-medium',
                    a.status === 'active' ? toneText.success : toneText.neutral,
                  )}
                >
                  {a.status === 'active' ? 'Live' : 'Removed'}
                </span>
                <span className="ml-auto">
                  <RemoveExposure allocation={a} port={port?.port} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {exposing && (
        <Expose scope={scope} candidates={candidates} open={exposing} onOpenChange={setExposing} />
      )}
    </Subsection>
  )
}

function Exposure({
  service,
  scope,
  publicAddress,
}: {
  service: Service
  scope: ServiceScope
  publicAddress?: string | null
}) {
  const [ports, domains, allocations] = useSuspenseQueries({
    queries: [portsQuery(service.id), domainsQuery(service.id), allocationsQuery(service.id)],
  })
  const [editing, setEditing] = useState<Editing | null>(null)
  const portList = ports.data.items
  const allocationList = allocations.data.items
  return (
    <>
      <PortsPart
        service={service}
        ports={portList}
        domains={domains.data.items}
        allocations={allocationList}
        onEdit={setEditing}
      />
      <DomainsPanel service={service.id} scope={scope} />
      <ExposuresPart
        scope={scope}
        ports={portList}
        allocations={allocationList}
        publicAddress={publicAddress}
        onEdit={setEditing}
      />
      {editing && (
        <EditPort
          key={`${editing.port.id}:${editing.protocol}`}
          service={service}
          ports={portList}
          allocations={allocationList}
          target={editing.port}
          initial={editing.protocol}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

export function PublicNetworking({
  service,
  protectedEnvironment,
}: {
  service: Service
  protectedEnvironment: boolean
}) {
  const station = useQuery(stationQuery(service.station_id))
  const trail = useEnvironmentTrail(service.environment_id)
  const scope = {
    project: trail.project.name,
    environment: trail.environment.name,
    service: service.name,
  }
  return (
    <section className="space-y-6" aria-labelledby="public-networking">
      <div className="space-y-1">
        <h2 id="public-networking" className="text-base font-semibold">
          Public networking
        </h2>
        <p className="text-sm text-muted-foreground">
          The internet reaches {service.name} on HTTP ports through domains, and on TCP ports
          through public TCP ports.
          {protectedEnvironment &&
            ' This environment is protected, so changes wait for your review.'}
        </p>
      </div>
      {station.data && !station.data.public_address && (
        <NoPublicAddress station={station.data} service={service.name} />
      )}
      {service.kind !== 'web' ? (
        <EmptyState
          icon={Globe}
          title="No public networking"
          description={`${serviceKind[service.kind]} services have no ports, so they have no domains or public TCP ports.`}
        />
      ) : (
        <Panel rows={3} title="Couldn’t load ports">
          <Exposure service={service} scope={scope} publicAddress={station.data?.public_address} />
        </Panel>
      )}
    </section>
  )
}
