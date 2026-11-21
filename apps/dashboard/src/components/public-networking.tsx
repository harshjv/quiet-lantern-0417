import { useSuspenseQueries } from '@tanstack/react-query'
import { CircleAlert, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { Code } from '@/components/code'
import { Confirm, RemoveButton } from '@/components/confirm'
import { DomainsPanel } from '@/components/domains-panel'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog, FormError } from '@/components/form-dialog'
import { EmptyState, ErrorState, Subsection } from '@/components/page'
import { Panel } from '@/components/panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, ApiFailure, idempotency, send, type App, type AppPort, type Domain } from '@/lib/api'
import { editItems } from '@/lib/cache'
import type { AppScope } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { appKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { domainsQuery, portsQuery, seedApp } from '@/lib/queries'
import { useTrail } from '@/lib/use-trail'

type Protocol = AppPort['protocol']

type PortSpec = { port: number; protocol: Protocol; grpc: boolean }

type Dependent = { id: string; hostname: string }

const specOf = (p: AppPort): PortSpec => ({
  port: p.port,
  protocol: p.protocol,
  grpc: p.grpc,
})

const protocolHelp: Record<Protocol, string> = {
  http: 'Takes a domain with HTTPS.',
  tcp: 'Inside its network only, for databases and other protocols.',
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

function FailureNotice({ error, title = portsFailed }: { error: unknown; title?: string }) {
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
              <entityIcon.domain className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">Domain</span>
              <Code>{d.hostname}</Code>
            </li>
          ))}
        </ul>
        <p>{error.fix} Remove them in Domains below.</p>
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
      hint="gRPC over HTTP/2."
    />
  )
}

function AddPort({
  app,
  ports,
  open,
  onOpenChange,
}: {
  app: App
  ports: AppPort[]
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
      error={change.isError && <FailureNotice error={change.error} />}
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
          className="w-32 tabular-nums"
          aria-invalid={taken || undefined}
          aria-describedby={taken ? 'port-number-taken' : undefined}
        />
        {taken && (
          <FormError id="port-number-taken">Port {port} exists. Edit that port instead.</FormError>
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
  target,
  initial,
  onClose,
}: {
  app: App
  ports: AppPort[]
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
      description={`Saving deploys ${app.name}. A domain on this port fixes its protocol.`}
      error={change.isError && <FailureNotice error={change.error} />}
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

function RemovePort({ app, ports, target }: { app: App; ports: AppPort[]; target: AppPort }) {
  const change = usePortsChange(app)
  const last = ports.length === 1

  return (
    <Confirm
      title={`Remove port ${target.port}?`}
      description={`Removing it deploys ${app.name}. Other apps that call this port lose their connection.`}
      action="Remove port"
      cancel="Keep port"
      renderError={(failure) => (
        <FailureNotice error={failure} title={`Couldn’t remove port ${target.port}`} />
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

function Reach({ port, domains }: { port: AppPort; domains: Domain[] }) {
  const mine = domains.filter((d) => d.app_port_id === port.id)

  return (
    <span className="text-xs text-muted-foreground">
      {port.protocol === 'tcp'
        ? 'Inside its network only'
        : mine.length
          ? mine.map((d) => d.hostname).join(', ')
          : 'No domain yet'}
    </span>
  )
}

type Editing = { port: AppPort; protocol: Protocol }

function PortsPart({
  app,
  ports,
  domains,
  onEdit,
}: {
  app: App
  ports: AppPort[]
  domains: Domain[]
  onEdit: (editing: Editing) => void
}) {
  const [adding, setAdding] = useState(false)

  return (
    <Subsection
      title="Ports"
      description="What the container listens on."
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
            <span className="text-sm font-medium tabular-nums">{port.port}</span>
            <Badge variant="outline">{port.protocol.toUpperCase()}</Badge>
            {port.grpc && <Badge variant="secondary">gRPC</Badge>}
            <Reach port={port} domains={domains} />
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
              <RemovePort app={app} ports={ports} target={port} />
            </span>
          </li>
        ))}
      </ul>
      {adding && <AddPort app={app} ports={ports} open={adding} onOpenChange={setAdding} />}
    </Subsection>
  )
}

function PortsAndDomains({ app, scope }: { app: App; scope: AppScope }) {
  const [ports, domains] = useSuspenseQueries({
    queries: [portsQuery(app.id), domainsQuery(app.id)],
  })
  const [editing, setEditing] = useState<Editing | null>(null)
  const portList = ports.data.items

  return (
    <>
      <PortsPart app={app} ports={portList} domains={domains.data.items} onEdit={setEditing} />
      <DomainsPanel app={app.id} scope={scope} />
      {editing && (
        <EditPort
          key={`${editing.port.id}:${editing.protocol}`}
          app={app}
          ports={portList}
          target={editing.port}
          initial={editing.protocol}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

export function PublicNetworking({ app, production }: { app: App; production: boolean }) {
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
        {production && (
          <p className="text-sm text-muted-foreground">
            Changes to production wait for an approval.
          </p>
        )}
      </div>
      {app.kind !== 'web' ? (
        <EmptyState
          icon={entityIcon.domain}
          title="No public networking"
          description={`${appKind[app.kind]} apps have no ports, so they have no domains.`}
        />
      ) : (
        <Panel rows={3} title="Couldn’t load ports">
          <PortsAndDomains app={app} scope={scope} />
        </Panel>
      )}
    </section>
  )
}
