import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Camera, Plus, ShieldCheck, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'

import { fitSandboxMemory, sandboxSizeDefaults } from '@stationly/protocol/domain'
import { gibibyte } from '@stationly/protocol/format'

import { AlsoWith, Code } from '@/components/code'
import { CheckboxField, Field, FieldSet, Suffixed } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { EmptyState, Section } from '@/components/page'
import { Panel } from '@/components/panel'
import {
  DeleteSandbox,
  ExtendSandbox,
  StartSandbox,
  StopSandbox,
} from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { SlugInput } from '@/components/slug-input'
import { SnapshotsTable } from '@/components/snapshots-table'
import { SandboxStatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, idempotency, send, type Environment } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { bytes } from '@/lib/format'
import { sandboxNetwork } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  sandboxesQuery,
  sandboxSnapshotsQuery,
  sandboxStationQuery,
  seedSandbox,
} from '@/lib/queries'
import { egressBody, egressText, imageText, parseDuration, ttlProblem } from '@/lib/sandbox'
import { isIdle, isLive } from '@/lib/status'

export function ProtectedNotice({ environment }: { environment: Environment }) {
  if (!environment.protected) return null
  return (
    <Alert>
      <ShieldCheck />
      <AlertTitle>Only people can change sandboxes here</AlertTitle>
      <AlertDescription>
        This environment is protected. Your changes apply at once. Stationly refuses sandbox changes
        from agents and tokens.
      </AlertDescription>
    </Alert>
  )
}

export function EgressFields({
  mode,
  onMode,
  domains,
  onDomains,
  idPrefix,
}: {
  mode: 'open' | 'allowlist'
  onMode: (mode: 'open' | 'allowlist') => void
  domains: string
  onDomains: (text: string) => void
  idPrefix: string
}) {
  return (
    <div className="space-y-3">
      <Field id={`${idPrefix}-egress`} label="Outbound traffic">
        <Select value={mode} onValueChange={(value) => onMode(value as 'open' | 'allowlist')}>
          <SelectTrigger id={`${idPrefix}-egress`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Any public destination</SelectItem>
            <SelectItem value="allowlist">Only the domains below</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === 'allowlist' && (
        <Field
          id={`${idPrefix}-domains`}
          label="Allowed domains"
          hint="One per line. Use *.example.com for subdomains and example.com:443,8443 for ports. Without ports, 80 and 443 apply."
        >
          <Textarea
            id={`${idPrefix}-domains`}
            rows={4}
            value={domains}
            onChange={(e) => onDomains(e.target.value)}
            placeholder={'registry.npmjs.org\n*.github.com:443'}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
      )}
    </div>
  )
}

type NewSandboxBody = Parameters<ReturnType<typeof api.v1.environments>['sandboxes']['post']>[0]

export function NewSandbox({
  environment,
  scope,
  open,
  onOpenChange,
}: {
  environment: Environment
  scope: Scope
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [custom, setCustom] = useState(false)
  const [image, setImage] = useState('')
  const [network, setNetwork] = useState<'isolated' | 'environment'>('isolated')
  const [ttl, setTtl] = useState('1h')
  const [mode, setMode] = useState<'open' | 'allowlist'>('open')
  const [domains, setDomains] = useState('')
  const [cpu, setCpu] = useState(String(sandboxSizeDefaults.cpu_millis / 1000))
  const [memory, setMemory] = useState(String(sandboxSizeDefaults.memory_bytes / gibibyte))
  const [memoryTouched, setMemoryTouched] = useState(false)
  const [disk, setDisk] = useState(String(sandboxSizeDefaults.disk_bytes / gibibyte))
  const station = useQuery({
    ...sandboxStationQuery,
    enabled: open,
  })
  const room = station.data?.sandbox_memory
  useEffect(() => {
    if (room && !memoryTouched) setMemory(String(fitSandboxMemory(room.free) / gibibyte))
  }, [room, memoryTouched])
  const [docker, setDocker] = useState(false)
  const [start, setStart] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const mutation = useApiMutation({
    mutationFn: (body: NewSandboxBody) =>
      send(
        api.v1
          .environments({
            environment: environment.id,
          })
          .sandboxes.post(body, idempotency()),
      ),
    seed: seedSandbox,
    invalidate: ['sandboxes'],
    success: (created) => ({
      title: `${created.name} created`,
      description:
        created.status === 'stopped' ? 'Start it when you need it.' : 'It’s starting now.',
    }),
    onSuccess: (result) => {
      onOpenChange(false)
      if (!result.staged)
        void navigate({
          to: '/sandboxes/$sandbox',
          params: {
            sandbox: result.body.id,
          },
        })
    },
  })
  const submit = () => {
    const ttl_s = parseDuration(ttl)
    const egress = egressBody(mode, domains)
    const found = ttlProblem(ttl_s) ?? egress.problem
    setProblem(found)
    if (found || ttl_s === null || !egress.egress) return
    mutation.mutate({
      ...(name
        ? {
            name,
          }
        : {}),
      ...(custom
        ? {
            image: {
              ref: image.trim(),
            },
          }
        : {}),
      network,
      ttl_s,
      docker,
      start,
      egress: egress.egress,
      size: {
        cpu_millis: Math.round(Number(cpu) * 1000),
        memory_bytes: Math.round(Number(memory) * gibibyte),
        disk_bytes: Math.round(Number(disk) * gibibyte),
      },
    })
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New sandbox"
      description="A machine for an agent or for you, with its own disk and a time limit. Stopping it keeps the disk."
      also={<AlsoWith cli={commands.createSandbox(scope)} tool="create_sandbox" />}
      error={problem ?? mutation.errorText}
      submitLabel="Create sandbox"
      pending={mutation.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sbx-name" label="Name (optional)">
          <SlugInput
            id="sbx-name"
            value={name}
            onValueChange={setName}
            placeholder="Leave empty to get a name"
          />
        </Field>
        <Field id="sbx-ttl" label="Time to live">
          <Input
            id="sbx-ttl"
            required
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            placeholder="1h"
            className="font-mono"
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sbx-image" label="Image">
          <Select
            value={custom ? 'custom' : 'toolchain'}
            onValueChange={(value) => setCustom(value === 'custom')}
          >
            <SelectTrigger id="sbx-image" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="toolchain">
                Toolchain (git, gh, Node, Python, Bun, Docker)
              </SelectItem>
              <SelectItem value="custom">Another image</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="sbx-network" label="Network">
          <Select
            value={network}
            onValueChange={(value) => setNetwork(value as 'isolated' | 'environment')}
          >
            <SelectTrigger id="sbx-network" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="isolated">Isolated, internet only</SelectItem>
              <SelectItem value="environment">Joins the environment network</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {custom && (
        <Field id="sbx-ref" label="Image reference">
          <Input
            id="sbx-ref"
            required
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="docker.io/library/python:3.13"
            className="font-mono"
          />
        </Field>
      )}
      <EgressFields
        mode={mode}
        onMode={setMode}
        domains={domains}
        onDomains={setDomains}
        idPrefix="sbx"
      />
      <FieldSet legend="Resources" className="grid gap-3 sm:grid-cols-3">
        <Field id="sbx-cpu" label="vCPU" labelClassName="font-normal">
          <Input
            id="sbx-cpu"
            type="number"
            required
            min={0.1}
            step="any"
            value={cpu}
            onChange={(e) => setCpu(e.target.value)}
          />
        </Field>
        <Field
          id="sbx-memory"
          label="Memory"
          labelClassName="font-normal"
          hint={
            room && room.free !== null && room.limit !== null
              ? `${bytes(room.free)} free of ${bytes(room.limit)} on ${station.data!.name}`
              : undefined
          }
        >
          <Suffixed suffix="GiB">
            <Input
              id="sbx-memory"
              type="number"
              required
              min={0.0625}
              step="any"
              value={memory}
              onChange={(e) => {
                setMemoryTouched(true)
                setMemory(e.target.value)
              }}
            />
          </Suffixed>
        </Field>
        <Field id="sbx-disk" label="Disk" labelClassName="font-normal">
          <Suffixed suffix="GiB">
            <Input
              id="sbx-disk"
              type="number"
              required
              min={1}
              step="any"
              value={disk}
              onChange={(e) => setDisk(e.target.value)}
            />
          </Suffixed>
        </Field>
      </FieldSet>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <CheckboxField
          id="sbx-docker"
          checked={docker}
          onCheckedChange={setDocker}
          label="Docker inside"
        />
        <CheckboxField
          id="sbx-start"
          checked={start}
          onCheckedChange={setStart}
          label="Start now"
        />
      </div>
    </FormDialog>
  )
}

function SandboxTable({
  environment,
  scope,
  onCreate,
}: {
  environment: Environment
  scope: Scope
  onCreate: () => void
}) {
  const { data } = useSuspenseQuery(sandboxesQuery(environment.id))
  if (data.items.length === 0)
    return (
      <EmptyState
        icon={TerminalSquare}
        title="No sandboxes yet"
        description="A sandbox is a machine for an agent or for you, with its own disk and a time limit."
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus /> New sandbox
          </Button>
        }
        also={<AlsoWith cli={commands.createSandbox(scope)} tool="create_sandbox" />}
      />
    )
  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Sandbox</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden xl:table-cell">Image</TableHead>
          <TableHead className="hidden lg:table-cell">Resources</TableHead>
          <TableHead className="hidden md:table-cell">Network</TableHead>
          <TableHead className="hidden sm:table-cell">Time</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((sandbox) => (
          <TableRow key={sandbox.id} className="relative">
            <TableCell>
              <Link
                to="/sandboxes/$sandbox"
                params={{
                  sandbox: sandbox.id,
                }}
                className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
                data-testid="sandbox-link"
              >
                <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
                {sandbox.name}
                {sandbox.forked_from && (
                  <Badge variant="outline" className="font-normal">
                    Fork
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
              <span className="font-mono text-[0.8125rem] text-muted-foreground">
                {imageText(sandbox.image)}
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
              {sandbox.size.cpu_millis / 1000} vCPU · {bytes(sandbox.size.memory_bytes)}
              <br />
              <span className="text-xs">
                {bytes(sandbox.disk_used_bytes)} of {bytes(sandbox.size.disk_bytes)} disk
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">
              {sandboxNetwork[sandbox.network]}
              <br />
              <span className="text-xs">Outbound to {egressText(sandbox.egress)}</span>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <TimeLeft sandbox={sandbox} />
            </TableCell>
            <TableCell className="relative z-10 text-right">
              <span className="inline-flex items-center gap-1">
                {isIdle(sandbox.status) ? (
                  <StartSandbox sandbox={sandbox} size="icon-sm" />
                ) : isLive(sandbox.status) ? (
                  <StopSandbox sandbox={sandbox} size="icon-sm" />
                ) : null}
                <ExtendSandbox sandbox={sandbox} size="icon-sm" />
                <DeleteSandbox sandbox={sandbox} size="icon-sm" />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function EnvironmentSnapshots({
  environment,
  project,
  scope,
}: {
  environment: Environment
  project: string
  scope: Scope
}) {
  const { data: snapshots } = useSuspenseQuery(sandboxSnapshotsQuery(environment.id))
  const { data: sandboxes } = useSuspenseQuery(sandboxesQuery(environment.id))
  const names = new Map(sandboxes.items.map((s) => [s.id, s.name]))
  return (
    <SnapshotsTable
      snapshots={snapshots.items}
      project={project}
      environment={environment.name}
      originLabel="Taken from"
      origin={(snapshot) =>
        names.get(snapshot.sandbox_id) ? (
          <Code>{names.get(snapshot.sandbox_id)}</Code>
        ) : (
          <span className="text-muted-foreground">Deleted sandbox</span>
        )
      }
      empty={
        <EmptyState
          icon={Camera}
          title="No snapshots yet"
          description="A snapshot saves a sandbox’s disk so you can fork new sandboxes from it. Take one from a sandbox’s page."
          also={
            <AlsoWith
              cli={commands.snapshotSandbox(scope, sandboxes.items[0]?.name ?? '<sandbox>')}
              tool="snapshot_sandbox"
            />
          }
        />
      }
    />
  )
}

export function SandboxesPanel({
  environment,
  project,
}: {
  environment: Environment
  project: string
}) {
  const [creating, setCreating] = useState(false)
  const scope = {
    project,
    environment: environment.name,
  }
  return (
    <div className="space-y-6">
      <ProtectedNotice environment={environment} />
      <Section
        title={<Term name="sandbox">Sandboxes</Term>}
        description="A running sandbox stops when its time runs out. Stationly deletes a stopped one after 7 days."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New sandbox
          </Button>
        }
      >
        <Panel title="Couldn’t load sandboxes">
          <SandboxTable
            environment={environment}
            scope={scope}
            onCreate={() => setCreating(true)}
          />
        </Panel>
      </Section>
      <Section
        title={<Term name="snapshot">Snapshots</Term>}
        description="Saved copies of a sandbox’s disk. Fork one to get a new sandbox."
      >
        <Panel rows={2} title="Couldn’t load snapshots">
          <EnvironmentSnapshots environment={environment} project={project} scope={scope} />
        </Panel>
      </Section>
      {creating && (
        <NewSandbox
          environment={environment}
          scope={scope}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </div>
  )
}
