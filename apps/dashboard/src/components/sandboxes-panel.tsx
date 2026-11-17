import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Camera, Container, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { fitMachineMemory, machineSizeDefaults } from '@stationly/protocol/domain'
import { gibibyte, parseSeconds } from '@stationly/protocol/format'

import { AlsoWith, Code } from '@/components/code'
import { CheckboxField, Field, FieldSet, Suffixed } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import {
  DeleteMachine,
  ExtendMachine,
  StartMachine,
  StopMachine,
} from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { SlugInput } from '@/components/slug-input'
import { SnapshotsTable } from '@/components/snapshots-table'
import { MachineStatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
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
import { api, idempotency, send } from '@/lib/api'
import { commands } from '@/lib/commands'
import { bytes } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { machineNetwork } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { isProduction, previewQuery, scopeOf, type Place, type PlaceView } from '@/lib/place'
import {
  machineSnapshotsQuery,
  machinesQuery,
  machineStationQuery,
  seedMachine,
} from '@/lib/queries'
import { egressBody, egressText, imageText, ttlProblem } from '@/lib/sandbox'
import { useShortcut } from '@/lib/shortcuts'
import { isIdle, isLive } from '@/lib/status'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'
import { MachineUseLine } from '@/workbench/machine-use'
import { Notice, Section } from '@/workbench/parts'

export function ProtectedNotice({ place }: { place: Place }) {
  if (!isProduction(place)) {
    return null
  }

  return (
    <Notice tone="info" title="Only people can change machines here">
      This is production. Your changes apply at once. Stationly refuses machine changes from agents
      and tokens.
    </Notice>
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

type NewMachineBody = Parameters<ReturnType<typeof api.v1.projects>['machines']['post']>[0]

export function NewMachine({
  place,
  open,
  onOpenChange,
}: {
  place: PlaceView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const scope = scopeOf(place)
  const [name, setName] = useState('')
  const [custom, setCustom] = useState(false)
  const [image, setImage] = useState('')
  const [network, setNetwork] = useState<'isolated' | 'environment'>('isolated')
  const [ttl, setTtl] = useState('1h')
  const [mode, setMode] = useState<'open' | 'allowlist'>('open')
  const [domains, setDomains] = useState('')
  const [cpu, setCpu] = useState(String(machineSizeDefaults.cpu_millis / 1000))
  const [memory, setMemory] = useState(String(machineSizeDefaults.memory_bytes / gibibyte))
  const [memoryTouched, setMemoryTouched] = useState(false)
  const [disk, setDisk] = useState(String(machineSizeDefaults.disk_bytes / gibibyte))
  const station = useQuery({
    ...machineStationQuery,
    enabled: open,
  })
  const room = station.data?.machine_memory

  useEffect(() => {
    if (room && !memoryTouched) {
      setMemory(String(fitMachineMemory(room.free) / gibibyte))
    }
  }, [room, memoryTouched])
  const [docker, setDocker] = useState(false)
  const [start, setStart] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: (body: NewMachineBody) =>
      send(
        api.v1
          .projects({
            project: place.project,
          })
          .machines.post(body, {
            ...idempotency(),
            query: previewQuery(place),
          }),
      ),
    seed: seedMachine,
    invalidate: ['machines'],
    success: (created) => ({
      title: `${created.name} created`,
      description:
        created.status === 'stopped' ? 'Start it when you need it.' : 'It’s starting now.',
    }),
    onSuccess: (result) => {
      onOpenChange(false)

      if (!result.waiting) {
        void navigate({
          to: '/machines/$machine/{-$tab}',
          params: {
            machine: result.body.id,
          },
        })
      }
    },
  })
  const submit = () => {
    const ttl_s = parseSeconds(ttl)
    const egress = egressBody(mode, domains)
    const found = ttlProblem(ttl_s) ?? egress.problem

    setProblem(found)

    if (found || ttl_s === null || !egress.egress) {
      return
    }

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
      title="New machine"
      description="A machine for an agent or for you, with its own disk and a time limit. Stopping it keeps the disk."
      also={<AlsoWith cli={commands.createMachine(scope)} tool="create_machine" />}
      error={problem ?? mutation.errorText}
      submitLabel="Create machine"
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
              <SelectItem value="environment">Joins the network</SelectItem>
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

function MachineTable({ place, onCreate }: { place: PlaceView; onCreate: () => void }) {
  const scope = scopeOf(place)
  const { data } = useSuspenseQuery(machinesQuery(place))
  const fresh = useFresh(data.items)

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.machine}
        title="No machines yet"
        description="A machine is an isolated computer on a server: the project machine where tasks run, a task’s own machine, or one you use by hand."
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus /> New machine
          </Button>
        }
        also={<AlsoWith cli={commands.createMachine(scope)} tool="create_machine" />}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Machine</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Used by</TableHead>
          <TableHead className="hidden xl:table-cell">Image</TableHead>
          <TableHead className="hidden lg:table-cell">Resources</TableHead>
          <TableHead className="hidden lg:table-cell">Network</TableHead>
          <TableHead className="hidden sm:table-cell">Time</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((machine) => (
          <TableRow key={machine.id} className={cn('relative', fresh.has(machine.id) && highlight)}>
            <TableCell>
              <Link
                to="/machines/$machine/{-$tab}"
                params={{
                  machine: machine.id,
                }}
                className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
                data-testid="machine-link"
              >
                <entityIcon.machine className="size-4 text-muted-foreground" aria-hidden />
                {machine.name}
                {machine.forked_from && (
                  <Badge variant="outline" className="font-normal">
                    Fork
                  </Badge>
                )}
              </Link>
              <span className="mt-0.5 block pl-6 text-xs sm:hidden">
                <TimeLeft machine={machine} />
              </span>
            </TableCell>
            <TableCell>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <MachineStatusBadge status={machine.status} reason={machine.status_reason} />
              </span>
            </TableCell>
            <TableCell className="hidden max-w-56 md:table-cell">
              <MachineUseLine machine={machine} />
            </TableCell>
            <TableCell className="hidden max-w-56 truncate xl:table-cell">
              <span className="font-mono text-[0.8125rem] text-muted-foreground">
                {imageText(machine.image)}
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
              {machine.size.cpu_millis / 1000} vCPU · {bytes(machine.size.memory_bytes)}
              <br />
              <span className="text-xs">
                {bytes(machine.disk_used_bytes)} of {bytes(machine.size.disk_bytes)} disk
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground lg:table-cell">
              {machineNetwork[machine.network]}
              <br />
              <span className="text-xs">Outbound to {egressText(machine.egress)}</span>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <TimeLeft machine={machine} />
            </TableCell>
            <TableCell className="relative z-10 text-right">
              <span className="inline-flex items-center gap-1">
                {isIdle(machine.status) ? (
                  <StartMachine machine={machine} size="icon-sm" />
                ) : isLive(machine.status) ? (
                  <StopMachine machine={machine} size="icon-sm" />
                ) : null}
                <ExtendMachine machine={machine} size="icon-sm" />
                <DeleteMachine machine={machine} size="icon-sm" />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function PlaceSnapshots({ place }: { place: PlaceView }) {
  const scope = scopeOf(place)
  const { data: snapshots } = useSuspenseQuery(machineSnapshotsQuery(place))
  const { data: machines } = useSuspenseQuery(machinesQuery(place))
  const names = new Map(machines.items.map((s) => [s.id, s.name]))

  return (
    <SnapshotsTable
      snapshots={snapshots.items}
      scope={scope}
      originLabel="Taken from"
      origin={(snapshot) =>
        names.get(snapshot.machine_id) ? (
          <Code>{names.get(snapshot.machine_id)}</Code>
        ) : (
          <span className="text-muted-foreground">Deleted machine</span>
        )
      }
      empty={
        <EmptyState
          icon={entityIcon.snapshot}
          title="No snapshots yet"
          description="A snapshot saves a machine’s disk so you can fork new machines from it. Take one from a machine’s page."
          also={
            <AlsoWith
              cli={commands.snapshotMachine(scope, machines.items[0]?.name ?? '<machine>')}
              tool="snapshot_machine"
            />
          }
        />
      }
    />
  )
}

export function MachinesPanel({ place }: { place: PlaceView }) {
  const [creating, setCreating] = useState(false)

  useShortcut('create', () => setCreating(true))

  return (
    <div className="flex flex-col gap-8">
      <ProtectedNotice place={place} />
      <Section
        icon={Container}
        title="Machines"
        note="A running machine stops when its time runs out. Stationly deletes a stopped one after 7 days."
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New machine
          </Button>
        }
      >
        <Panel title="Couldn’t load machines">
          <MachineTable place={place} onCreate={() => setCreating(true)} />
        </Panel>
      </Section>
      <Section
        icon={Camera}
        title="Snapshots"
        note="Saved copies of a machine’s disk. Fork one to get a new machine."
      >
        <Panel rows={2} title="Couldn’t load snapshots">
          <PlaceSnapshots place={place} />
        </Panel>
      </Section>
      {creating && <NewMachine place={place} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}
