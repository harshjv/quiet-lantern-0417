import { useQuery, useSuspenseQueries } from '@tanstack/react-query'
import { Cable, CircleAlert, Pencil, Plus, TriangleAlert } from 'lucide-react'
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
  type App,
  type AppPort,
  type Domain,
  type PortAllocation,
} from '@/lib/api'
import { editItems } from '@/lib/cache'
import { commands, type AppScope } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { appKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { allocationsQuery, domainsQuery, portsQuery, seedApp, stationQuery } from '@/lib/queries'
import { toneText, warningAlert } from '@/lib/tone'
import { useTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

type Protocol = AppPort['protocol']

type PortSpec = { port: number; protocol: Protocol; grpc: boolean }

type Dependent = { entity: string; id: string; hostname?: string; host_port?: number }

const specOf = (p: AppPort): PortSpec => ({
  port: p.port,
  protocol: p.protocol,
  grpc: p.grpc,
})

const protocolHelp: Record<Protocol, string> = {
  http: 'Reachable through a domain with HTTPS.',
  tcp: 'Reachable on a public port of the server, for databases and other protocols.',
}

type PortsChange = { ports: PortSpec[]; done: string; waiting: string }

const portsFailed = 'Couldn’t save the ports'

function usePortsChange(app: App) {
  return useApiMutation({
    mutationFn: (input: PortsChange) =>
      send(
        api.v1
          .apps({
            app: app.id,
          })
          .patch(
            {
              ports: input.ports,
            },
            idempotency(),
          ),
      ),
    optimistic: (input) => [
      editItems(portsQuery(app.id), (ports) =>
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
    seed: seedApp,
    invalidate: ['networking'],
    waiting: (input) => input.waiting,
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
  if (!(error instanceof ApiFailure)) {
    return <ErrorState error={error} title={title} />
  }

  const dependents =
    error.code === 'DELETE_HAS_DEPENDENTS' && Array.isArray(error.details.dependents)
      ? (error.details.dependents as Dependent[])
      : []

  if (dependents.length === 0) {
    return <ErrorState error={error} title={title} />
  }

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
                <entityIcon.domain className="size-4 text-muted-foreground" aria-hidden />
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
  app,
  ports,
  allocations,
  open,
  onOpenChange,
}: {
  app: App
  ports: AppPort[]
  allocations: PortAllocation[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const change = usePortsChange(app)
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
        waiting: `Add port ${number} to ${app.name}`,
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
      description={`Adding a port deploys ${app.name}.`}
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
            {app.name} already has port {port}. Edit that port instead.
          </FormError>
        )}
      </Field>
      <ProtocolChoice value={protocol} onChange={setProtocol} name="add-port-protocol" />
      <GrpcChoice id="add-port-grpc" checked={grpc} onChange={setGrpc} />
    </FormDialog>
  )
}

function EditPort({
  app,
  ports,
  allocations,
  target,
  initial,
  onClose,
}: {
  app: App
  ports: AppPort[]
  allocations: PortAllocation[]
  target: AppPort
  initial: Protocol
  onClose: () => void
}) {
  const change = usePortsChange(app)
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
        waiting: `Change port ${target.port} of ${app.name}`,
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
      description={`Saving deploys ${app.name}. You can’t change the protocol while a domain or public TCP port uses this port.`}
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
  app,
  ports,
  allocations,
  target,
}: {
  app: App
  ports: AppPort[]
  allocations: PortAllocation[]
  target: AppPort
}) {
  const change = usePortsChange(app)
  const last = ports.length === 1

  return (
    <Confirm
      title={`Remove port ${target.port}?`}
      description={`Removing it deploys ${app.name}. Other apps that call this port lose their connection.`}
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
          waiting: `Remove port ${target.port} from ${app.name}`,
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
          title={last ? 'A web app needs at least one port.' : undefined}
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
  port: AppPort
  domains: Domain[]
  allocations: PortAllocation[]
}) {
  if (port.protocol === 'http') {
    const mine = domains.filter((d) => d.app_port_id === port.id)

    return (
      <span className="text-xs text-muted-foreground">
        {mine.length ? mine.map((d) => d.hostname).join(', ') : 'No domain yet'}
      </span>
    )
  }

  const mine = allocations.filter((a) => a.app_port_id === port.id)

  return (
    <span className="text-xs text-muted-foreground">
      {mine.length ? mine.map((a) => a.address ?? `port ${a.host_port}`).join(', ') : 'Not public'}
    </span>
  )
}

type Editing = { port: AppPort; protocol: Protocol }

function PortsPart({
  app,
  ports,
  domains,
  allocations,
  onEdit,
}: {
  app: App
  ports: AppPort[]
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
        aria-label={`Ports of ${app.name}`}
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
              <RemovePort app={app} ports={ports} allocations={allocations} target={port} />
            </span>
          </li>
        ))}
      </ul>
      {adding && (
        <AddPort
          app={app}
          ports={ports}
          allocations={allocations}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
    </Subsection>
  )
}

function NoPublicAddress({ station, app }: { station: { name: string }; app: string }) {
  return (
    <Alert data-testid="no-public-address" className={warningAlert}>
      <TriangleAlert />
      <AlertTitle>Server {station.name} has no public address</AlertTitle>
      <AlertDescription className="space-y-3 text-current">
        <p>
          Domains and public TCP ports can’t reach {app} until you set one. Ports you expose now
          keep their number.
        </p>
        <CommandBlock
          commands={commands.setPublicAddress(station.name)}
          caption="Run on your computer"
          className="bg-background/70"
        />
        <AlsoWith tool="update_server" className="justify-start" />
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
  scope: AppScope
  candidates: AppPort[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [port, setPort] = useState(candidates[0]?.id ?? '')
  const chosen = candidates.find((p) => p.id === port) ?? candidates[0]
  const mutation = useApiMutation({
    mutationFn: (id: string) =>
      send(
        api.v1
          .ports({
            id,
          })
          ['port-allocations'].post(undefined, idempotency()),
      ),
    invalidate: ['networking'],
    waiting: () => `Expose port ${chosen?.port} of ${scope.app}`,
    onSuccess: (outcome) => {
      if (outcome.waiting) {
        onOpenChange(false)
      }
    },
  })
  const result = mutation.data?.waiting === false ? mutation.data.body : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogScroll}>
        {result ? (
          <div className="space-y-4" aria-live="polite">
            <DialogHeader>
              <DialogTitle>Port {chosen?.port} is public</DialogTitle>
              <DialogDescription>
                Clients on the internet connect to this address. The server forwards it to the
                container.
              </DialogDescription>
            </DialogHeader>
            {result.address ? (
              <div
                className="rounded-md border bg-muted/40 px-3 py-2"
                data-testid="exposed-address"
              >
                <AddressLine address={result.address} />
              </div>
            ) : (
              <p className="text-sm" data-testid="exposed-address">
                Stationly reserved port <Code>{result.host_port}</Code>. The station has no public
                address, so nothing reaches it yet.
              </p>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <DialogForm
            title="Expose a TCP port"
            description="Stationly picks a free port on the server and forwards it to the port you choose."
            error={
              mutation.isError && (
                <ErrorState error={mutation.error} title={`Couldn’t expose port ${chosen?.port}`} />
              )
            }
            also={<AlsoWith cli={commands.exposeTcp(chosen?.id ?? null)} tool="expose_tcp" />}
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
    waiting: () => `Remove ${label}`,
    success: () => ({
      title: `${label} removed`,
      description: 'The server stops forwarding it within a few seconds.',
    }),
  })

  return (
    <Confirm
      title={`Remove ${label}?`}
      description={`Clients connected through it lose their connection${port ? `, and port ${port} stays reachable inside its network only` : ''}. If you expose it again, it may get a different number.`}
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
  scope: AppScope
  ports: AppPort[]
  allocations: PortAllocation[]
  publicAddress: string | null | undefined
  onEdit: (editing: Editing) => void
}) {
  const [exposing, setExposing] = useState(false)
  const tcp = ports.filter((p) => p.protocol === 'tcp')
  const exposed = new Set(allocations.map((a) => a.app_port_id))
  const candidates = tcp.filter((p) => !exposed.has(p.id))
  const portOf = new Map(ports.map((p) => [p.id, p]))
  const http = ports.filter((p) => p.protocol === 'http')

  return (
    <Subsection
      title={<Term name="publicTcpPort">Public TCP ports</Term>}
      description={`TCP from the internet on a port of ${publicAddress ?? 'the server'}, for databases and other protocols.`}
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
          description="A public TCP port lets clients on the internet connect to a TCP port of this app."
          action={
            <Button size="sm" onClick={() => setExposing(true)}>
              <Cable /> Expose port {candidates[0]?.port}
            </Button>
          }
          also={<AlsoWith cli={commands.exposeTcp(candidates[0]?.id ?? null)} tool="expose_tcp" />}
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Public TCP ports">
          {allocations.map((a) => {
            const port = portOf.get(a.app_port_id)

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
  app,
  scope,
  publicAddress,
}: {
  app: App
  scope: AppScope
  publicAddress?: string | null
}) {
  const [ports, domains, allocations] = useSuspenseQueries({
    queries: [portsQuery(app.id), domainsQuery(app.id), allocationsQuery(app.id)],
  })
  const [editing, setEditing] = useState<Editing | null>(null)
  const portList = ports.data.items
  const allocationList = allocations.data.items

  return (
    <>
      <PortsPart
        app={app}
        ports={portList}
        domains={domains.data.items}
        allocations={allocationList}
        onEdit={setEditing}
      />
      <DomainsPanel app={app.id} scope={scope} />
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
          app={app}
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

export function PublicNetworking({ app, production }: { app: App; production: boolean }) {
  const station = useQuery(stationQuery(app.server_id))
  const trail = useTrail(app)
  const scope = {
    ...trail.scope,
    app: app.name,
  }

  return (
    <section className="space-y-6" aria-labelledby="public-networking">
      <div className="space-y-1">
        <h2 id="public-networking" className="text-base font-semibold">
          Public networking
        </h2>
        <p className="text-sm text-muted-foreground">
          The internet reaches {app.name} on HTTP ports through domains, and on TCP ports through
          public TCP ports.
          {production && ' This is production, so changes wait for an approval.'}
        </p>
      </div>
      {station.data && !station.data.public_address && (
        <NoPublicAddress station={station.data} app={app.name} />
      )}
      {app.kind !== 'web' ? (
        <EmptyState
          icon={entityIcon.domain}
          title="No public networking"
          description={`${appKind[app.kind]} apps have no ports, so they have no domains or public TCP ports.`}
        />
      ) : (
        <Panel rows={3} title="Couldn’t load ports">
          <Exposure app={app} scope={scope} publicAddress={station.data?.public_address} />
        </Panel>
      )}
    </section>
  )
}
