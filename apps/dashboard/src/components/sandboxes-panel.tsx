import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, ShieldCheck, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'

import { fitSandboxMemory, sandboxSizeDefaults } from '@stationly/protocol/domain'
import { gibibyte } from '@stationly/protocol/format'

import { CheckboxField, Field, FieldSet } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Empty, Mono, Section } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
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
import { bytes } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { sandboxesQuery, sandboxSnapshotsQuery, sandboxStationQuery } from '@/lib/queries'
import { egressBody, egressText, imageText, parseDuration, ttlProblem } from '@/lib/sandbox'
import { isIdle, isLive } from '@/lib/status'

export function ProtectedNotice({ environment }: { environment: Environment }) {
  if (!environment.protected) return null
  return (
    <Alert>
      <ShieldCheck />
      <AlertTitle>Protected environment</AlertTitle>
      <AlertDescription>
        Sandbox changes here need a human. This dashboard session is one, so they apply at once; a
        token, an agent or an OAuth client is refused with PROTECTED_ENVIRONMENT.
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
            <SelectItem value="open">Open: any public destination</SelectItem>
            <SelectItem value="allowlist">Allowlist: only the domains below</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === 'allowlist' && (
        <Field
          id={`${idPrefix}-domains`}
          label="Allowed domains"
          hint="One per line or separated by spaces. Prefix a wildcard with *. and add ports after a colon, such as example.com:443,8443. Without ports, the default ports apply."
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

function NewSandbox({
  environment,
  open,
  onOpenChange,
}: {
  environment: Environment
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
    invalidate: ['sandboxes'],
    success: (created) => ({
      title: `${created.name} created`,
      description:
        created.status === 'stopped'
          ? 'It is stopped; start it when you need it.'
          : 'It is starting.',
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
      description="A persistent machine for an agent or a person, isolated with gVisor. Its disk is kept while it is stopped."
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
            placeholder="named for you if empty"
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
              <SelectItem value="isolated">Isolated: public internet only</SelectItem>
              <SelectItem value="environment">Environment: joins its private network</SelectItem>
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
          label="Memory (GiB)"
          labelClassName="font-normal"
          hint={
            room && room.free !== null && room.limit !== null
              ? `${bytes(room.free)} free of ${bytes(room.limit)} on ${station.data!.name}`
              : undefined
          }
        >
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
        </Field>
        <Field id="sbx-disk" label="Disk (GiB)" labelClassName="font-normal">
          <Input
            id="sbx-disk"
            type="number"
            required
            min={1}
            step="any"
            value={disk}
            onChange={(e) => setDisk(e.target.value)}
          />
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

function SandboxTable({ environment }: { environment: Environment }) {
  const sandboxes = useQuery(sandboxesQuery(environment.id))
  return (
    <QueryState
      query={sandboxes}
      isEmpty={noItems}
      empty={
        <Empty title="No sandboxes in this environment">
          Create one with New sandbox, <Mono>sly sandbox create</Mono> or the create_sandbox MCP
          tool.
        </Empty>
      }
    >
      {(data) => (
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
      )}
    </QueryState>
  )
}

function EnvironmentSnapshots({
  environment,
  project,
}: {
  environment: Environment
  project: string
}) {
  const snapshots = useQuery(sandboxSnapshotsQuery(environment.id))
  const sandboxes = useQuery(sandboxesQuery(environment.id))
  const names = new Map((sandboxes.data?.items ?? []).map((s) => [s.id, s.name]))
  return (
    <SnapshotsTable
      query={snapshots}
      project={project}
      environment={environment.name}
      originLabel="Taken from"
      origin={(snapshot) =>
        names.get(snapshot.sandbox_id) ? (
          <Mono>{names.get(snapshot.sandbox_id)}</Mono>
        ) : (
          <span className="text-muted-foreground">deleted sandbox</span>
        )
      }
      empty={
        <Empty title="No snapshots">
          Take one from a sandbox page, with sly sandbox snapshot, or with the snapshot_sandbox MCP
          tool.
        </Empty>
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
      <Section
        title="Snapshots"
        description="Read-only copies of a sandbox disk. Fork one to get a new sandbox."
      >
        <EnvironmentSnapshots environment={environment} project={project} />
      </Section>
      {creating && (
        <NewSandbox environment={environment} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  )
}
