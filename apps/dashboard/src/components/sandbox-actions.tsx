import { useNavigate } from '@tanstack/react-router'
import {
  CircleAlert,
  GitFork,
  Loader2,
  Play,
  Square,
  Timer,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ComponentProps } from 'react'

import { parseSeconds } from '@stationly/protocol/format'

import { Confirm } from '@/components/confirm'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, idempotency, send, type Machine, type MachineSnapshot } from '@/lib/api'
import { scopeLabel, type Scope } from '@/lib/commands'
import { plural, span } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { machineTo } from '@/lib/links'
import { useApiMutation } from '@/lib/mutation'
import { placeOf, previewQuery } from '@/lib/place'
import { patchMachine, seedMachine, seedSnapshot } from '@/lib/queries'
import { ttlProblem } from '@/lib/sandbox'
import { isIdle } from '@/lib/status'

type Named = Pick<Machine, 'id' | 'name' | 'status' | 'project_id' | 'preview_id'>

type Size = 'sm' | 'icon-sm'

function ActionButton({
  icon: Icon,
  label,
  subject,
  size = 'sm',
  pending,
  ...props
}: ComponentProps<typeof Button> & {
  icon: LucideIcon
  label: string
  subject: string
  size?: Size
  pending?: boolean
}) {
  return (
    <Button
      variant="outline"
      size={size}
      aria-label={size === 'icon-sm' ? `${label} ${subject}` : undefined}
      {...props}
    >
      {pending ? <Loader2 className="animate-spin" /> : <Icon />}
      {size === 'sm' && label}
    </Button>
  )
}

const power = {
  start: {
    icon: Play,
    label: 'Start',
    status: 'starting',
    success: (name: string) => ({
      title: `${name} is starting`,
    }),
    failure: (name: string) => `start ${name}`,
  },
  stop: {
    icon: Square,
    label: 'Stop',
    status: 'stopping',
    success: (name: string) => ({
      title: `${name} is stopping`,
      description: 'Stationly keeps its disk.',
    }),
    failure: (name: string) => `stop ${name}`,
  },
} as const

export const useMachinePower = (
  machine: Pick<Machine, 'id' | 'name'> & Partial<Pick<Machine, 'project_id' | 'preview_id'>>,
  action: keyof typeof power,
) => {
  const { status, success, failure } = power[action]

  return useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .machines({
            machine: machine.id,
          })
          [action].post(undefined, idempotency()),
      ),
    optimistic: () =>
      patchMachine(machine, {
        status,
        status_reason: null,
      }),
    seed: seedMachine,
    invalidate: ['machines'],
    success: () => success(machine.name),
    failure: () => failure(machine.name),
  })
}

function PowerButton({
  machine,
  action,
  size,
}: {
  machine: Named
  action: keyof typeof power
  size?: Size
}) {
  const { icon, label } = power[action]
  const mutation = useMachinePower(machine, action)

  return (
    <ActionButton
      icon={icon}
      label={label}
      subject={machine.name}
      size={size}
      pending={mutation.isPending}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    />
  )
}

export const StartMachine = (props: { machine: Named; size?: Size }) => (
  <PowerButton action="start" {...props} />
)

export const StopMachine = (props: { machine: Named; size?: Size }) => (
  <PowerButton action="stop" {...props} />
)

const presets = ['30m', '1h', '4h', '12h', '1d']

type Extendable = { machine: Named & Pick<Machine, 'ttl_s'>; size?: Size }

export const ExtendMachine = ({ machine, size }: Extendable) =>
  machine.ttl_s === null ? null : (
    <ExtendDialog
      machine={{
        ...machine,
        ttl_s: machine.ttl_s,
      }}
      size={size}
    />
  )

function ExtendDialog({
  machine,
  size = 'sm',
}: {
  machine: Named & { ttl_s: number }
  size?: Size
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('1h')
  const [problem, setProblem] = useState<string | null>(null)
  const mutation = useApiMutation({
    mutationFn: (ttl_s: number) =>
      send(
        api.v1
          .machines({
            machine: machine.id,
          })
          .patch(
            {
              ttl_s,
            },
            idempotency(),
          ),
      ),
    seed: seedMachine,
    invalidate: ['machines'],
    success: (_, ttl_s) => `${machine.name} now stops in ${span(ttl_s)}`,
    failure: () => `extend ${machine.name}`,
    onSuccess: () => setOpen(false),
  })
  const submit = () => {
    const seconds = parseSeconds(text)
    const found = ttlProblem(seconds)

    setProblem(found)

    if (!found && seconds !== null) {
      mutation.mutate(seconds)
    }
  }

  return (
    <>
      <ActionButton
        icon={Timer}
        label="Extend"
        subject={machine.name}
        size={size}
        onClick={() => setOpen(true)}
        disabled={isIdle(machine.status)}
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={`Extend ${machine.name}`}
        description={`${machine.name} stops this long from now, replacing the time it has left. Its time to live is ${span(machine.ttl_s)}.`}
        error={problem ?? mutation.errorText}
        submitLabel="Extend"
        pending={mutation.isPending}
        onSubmit={submit}
      >
        <Field id="extend-ttl" label="Time to live">
          <Input
            id="extend-ttl"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono"
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {presets.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="xs"
                variant={text === preset ? 'secondary' : 'outline'}
                onClick={() => setText(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
        </Field>
      </FormDialog>
    </>
  )
}

export const CopiedFilesNotice = () => (
  <p className="flex items-start gap-2 text-sm text-muted-foreground">
    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
    Every snapshot and fork gets a copy of the disk, credentials included.
  </p>
)

function CopyDialog({
  id,
  title,
  description,
  submitLabel,
  error,
  pending,
  onSubmit,
  onOpenChange,
}: {
  id: string
  title: string
  description: string
  submitLabel: string
  error: string | null
  pending: boolean
  onSubmit: (name: string) => void
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      notice={<CopiedFilesNotice />}
      error={error}
      submitLabel={submitLabel}
      pending={pending}
      onSubmit={() => onSubmit(name)}
    >
      <Field id={id} label="Name (optional)">
        <SlugInput id={id} value={name} onValueChange={setName} />
      </Field>
    </FormDialog>
  )
}

export function SnapshotMachine({ machine }: { machine: Named }) {
  const [open, setOpen] = useState(false)
  const mutation = useApiMutation({
    mutationFn: (name: string) =>
      send(
        api.v1
          .machines({
            machine: machine.id,
          })
          .snapshots.post(
            name
              ? {
                  name,
                }
              : {},
            idempotency(),
          ),
      ),
    seed: seedSnapshot,
    invalidate: ['machines'],
    success: (snapshot) =>
      snapshot.status === 'ready'
        ? `Snapshot ${snapshot.name ?? snapshot.id} is ready`
        : `Taking snapshot ${snapshot.name ?? snapshot.id}`,
    failure: () => `snapshot ${machine.name}`,
    onSuccess: () => setOpen(false),
  })

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={machine.status === 'creating' || machine.status === 'deleting'}
      >
        <entityIcon.snapshot /> Snapshot
      </Button>
      {open && (
        <CopyDialog
          id="snapshot-name"
          title={`Snapshot ${machine.name}`}
          description="Saves a read-only copy of the disk. Stationly copies a running machine as it is, so data its processes haven’t written yet is missing."
          submitLabel="Take snapshot"
          error={mutation.errorText}
          pending={mutation.isPending}
          onSubmit={(name) => mutation.mutate(name)}
          onOpenChange={(next) => {
            setOpen(next)

            if (!next) {
              mutation.reset()
            }
          }}
        />
      )}
    </>
  )
}

type ForkSource =
  { kind: 'machine'; machine: Named } | { kind: 'snapshot'; snapshot: MachineSnapshot }

export function ForkButton({
  source,
  scope,
  label = 'Fork',
  size = 'sm',
}: {
  source: ForkSource
  scope: Scope
  label?: string
  size?: Size
}) {
  const [open, setOpen] = useState(false)
  const from =
    source.kind === 'machine'
      ? {
          machine: source.machine.id,
        }
      : {
          snapshot: source.snapshot.id,
        }
  const place = placeOf(source.kind === 'machine' ? source.machine : source.snapshot)
  const subject =
    source.kind === 'machine' ? source.machine.name : (source.snapshot.name ?? source.snapshot.id)
  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: (name: string) =>
      send(
        api.v1
          .projects({
            project: place.project,
          })
          .machines.post(
            {
              from,
              ...(name
                ? {
                    name,
                  }
                : {}),
            },
            {
              ...idempotency(),
              query: previewQuery(place),
            },
          ),
      ),
    seed: seedMachine,
    invalidate: ['machines'],
    success: (created) => `${created.name} forked from ${subject}`,
    failure: () => `fork ${subject}`,
    onSuccess: (result) => {
      setOpen(false)

      if (!result.waiting) {
        void navigate(machineTo(result.body.id))
      }
    },
  })

  return (
    <>
      <ActionButton
        icon={GitFork}
        label={label}
        subject={subject}
        size={size}
        onClick={() => setOpen(true)}
      />
      {open && (
        <CopyDialog
          id="fork-name"
          title={`Fork ${subject}`}
          description={`Creates a machine in ${scopeLabel(scope)} from a copy of ${source.kind === 'machine' ? `${subject}’s disk` : 'the snapshot'}, with the same size, network and outbound traffic rules.`}
          submitLabel="Fork"
          error={mutation.errorText}
          pending={mutation.isPending}
          onSubmit={(name) => mutation.mutate(name)}
          onOpenChange={(next) => {
            setOpen(next)

            if (!next) {
              mutation.reset()
            }
          }}
        />
      )}
    </>
  )
}

export function DeleteMachine({
  machine,
  size = 'sm',
  after,
}: {
  machine: Named
  size?: Size
  after?: () => void
}) {
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .machines({
            machine: machine.id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['machines'],
    success: (result) => ({
      title: `${machine.name} deleted`,
      description: result.snapshots_kept
        ? `${plural(result.snapshots_kept, 'snapshot')} kept.`
        : undefined,
    }),
    onSuccess: () => after?.(),
  })

  return (
    <Confirm
      title={`Delete machine ${machine.name}?`}
      description="Stationly deletes the machine and its disk. Snapshots taken from it stay."
      action="Delete machine"
      cancel="Keep machine"
      onConfirm={() => mutation.mutateAsync()}
      trigger={
        <ActionButton
          icon={Trash2}
          label="Delete"
          subject={machine.name}
          size={size}
          disabled={machine.status === 'deleting'}
        />
      }
    />
  )
}

export function DeleteSnapshot({ snapshot }: { snapshot: MachineSnapshot }) {
  const label = snapshot.name ?? snapshot.id
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1['machine-snapshots']({
          id: snapshot.id,
        }).delete(undefined, idempotency()),
      ),
    invalidate: ['machines'],
    success: () => `Snapshot ${label} deleted`,
  })

  return (
    <Confirm
      title={`Delete snapshot ${label}?`}
      description="Machines forked from it keep their own disks."
      action="Delete snapshot"
      cancel="Keep snapshot"
      onConfirm={() => mutation.mutateAsync()}
      trigger={
        <ActionButton
          icon={Trash2}
          label="Delete"
          subject={`snapshot ${label}`}
          size="icon-sm"
          disabled={snapshot.status === 'deleting'}
        />
      }
    />
  )
}
