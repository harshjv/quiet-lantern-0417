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
import { api, idempotency, send, type Sandbox, type SandboxSnapshot } from '@/lib/api'
import { plural, span } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { useApiMutation } from '@/lib/mutation'
import { patchSandbox, seedSandbox, seedSnapshot } from '@/lib/queries'
import { ttlProblem } from '@/lib/sandbox'
import { isIdle } from '@/lib/status'

type Named = Pick<Sandbox, 'id' | 'name' | 'status'> & { environment_id: string }

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

export const useSandboxPower = (
  sandbox: Pick<Sandbox, 'id' | 'name'> & Partial<Pick<Sandbox, 'environment_id'>>,
  action: keyof typeof power,
) => {
  const { status, success, failure } = power[action]

  return useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          [action].post(undefined, idempotency()),
      ),
    optimistic: () =>
      patchSandbox(sandbox, {
        status,
        status_reason: null,
      }),
    seed: seedSandbox,
    invalidate: ['sandboxes'],
    success: () => success(sandbox.name),
    failure: () => failure(sandbox.name),
  })
}

function PowerButton({
  sandbox,
  action,
  size,
}: {
  sandbox: Named
  action: keyof typeof power
  size?: Size
}) {
  const { icon, label } = power[action]
  const mutation = useSandboxPower(sandbox, action)

  return (
    <ActionButton
      icon={icon}
      label={label}
      subject={sandbox.name}
      size={size}
      pending={mutation.isPending}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    />
  )
}

export const StartSandbox = (props: { sandbox: Named; size?: Size }) => (
  <PowerButton action="start" {...props} />
)

export const StopSandbox = (props: { sandbox: Named; size?: Size }) => (
  <PowerButton action="stop" {...props} />
)

const presets = ['30m', '1h', '4h', '12h', '1d']

type Extendable = { sandbox: Named & Pick<Sandbox, 'ttl_s'>; size?: Size }

export const ExtendSandbox = ({ sandbox, size }: Extendable) =>
  sandbox.ttl_s === null ? null : (
    <ExtendDialog
      sandbox={{
        ...sandbox,
        ttl_s: sandbox.ttl_s,
      }}
      size={size}
    />
  )

function ExtendDialog({
  sandbox,
  size = 'sm',
}: {
  sandbox: Named & { ttl_s: number }
  size?: Size
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('1h')
  const [problem, setProblem] = useState<string | null>(null)
  const mutation = useApiMutation({
    mutationFn: (ttl_s: number) =>
      send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          .patch(
            {
              ttl_s,
            },
            idempotency(),
          ),
      ),
    seed: seedSandbox,
    invalidate: ['sandboxes'],
    success: (_, ttl_s) => `${sandbox.name} now stops in ${span(ttl_s)}`,
    failure: () => `extend ${sandbox.name}`,
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
        subject={sandbox.name}
        size={size}
        onClick={() => setOpen(true)}
        disabled={isIdle(sandbox.status)}
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={`Extend ${sandbox.name}`}
        description={`${sandbox.name} stops this long from now, replacing the time it has left. Its time to live is ${span(sandbox.ttl_s)}.`}
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

export function SnapshotSandbox({ sandbox }: { sandbox: Named }) {
  const [open, setOpen] = useState(false)
  const mutation = useApiMutation({
    mutationFn: (name: string) =>
      send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
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
    invalidate: ['sandboxes'],
    success: (snapshot) =>
      snapshot.status === 'ready'
        ? `Snapshot ${snapshot.name ?? snapshot.id} is ready`
        : `Taking snapshot ${snapshot.name ?? snapshot.id}`,
    failure: () => `snapshot ${sandbox.name}`,
    onSuccess: () => setOpen(false),
  })

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={sandbox.status === 'creating' || sandbox.status === 'deleting'}
      >
        <entityIcon.snapshot /> Snapshot
      </Button>
      {open && (
        <CopyDialog
          id="snapshot-name"
          title={`Snapshot ${sandbox.name}`}
          description="Saves a read-only copy of the disk. Stationly copies a running sandbox as it is, so data its processes haven’t written yet is missing."
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
  { kind: 'sandbox'; sandbox: Named } | { kind: 'snapshot'; snapshot: SandboxSnapshot }

export function ForkButton({
  source,
  project,
  environment,
  label = 'Fork',
  size = 'sm',
}: {
  source: ForkSource
  project: string
  environment: string
  label?: string
  size?: Size
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const from =
    source.kind === 'sandbox'
      ? {
          sandbox: source.sandbox.id,
        }
      : {
          snapshot: source.snapshot.id,
        }
  const environmentId =
    source.kind === 'sandbox' ? source.sandbox.environment_id : source.snapshot.environment_id
  const subject =
    source.kind === 'sandbox' ? source.sandbox.name : (source.snapshot.name ?? source.snapshot.id)
  const mutation = useApiMutation({
    mutationFn: (name: string) =>
      send(
        api.v1
          .environments({
            environment: environmentId,
          })
          .sandboxes.post(
            {
              from,
              ...(name
                ? {
                    name,
                  }
                : {}),
            },
            idempotency(),
          ),
      ),
    seed: seedSandbox,
    invalidate: ['sandboxes'],
    success: (created) => `${created.name} forked from ${subject}`,
    failure: () => `fork ${subject}`,
    onSuccess: (result) => {
      setOpen(false)

      if (!result.staged) {
        void navigate({
          to: '/sandboxes/$sandbox',
          params: {
            sandbox: result.body.id,
          },
        })
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
          description={`Creates a sandbox in ${project}/${environment} from a copy of ${source.kind === 'sandbox' ? `${subject}’s disk` : 'the snapshot'}, with the same size, network and outbound traffic rules.`}
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

export function DeleteSandbox({
  sandbox,
  size = 'sm',
  after,
}: {
  sandbox: Named
  size?: Size
  after?: () => void
}) {
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['sandboxes'],
    success: (result) => ({
      title: `${sandbox.name} deleted`,
      description: result.snapshots_kept
        ? `${plural(result.snapshots_kept, 'snapshot')} kept.`
        : undefined,
    }),
    onSuccess: () => after?.(),
  })

  return (
    <Confirm
      title={`Delete sandbox ${sandbox.name}?`}
      description="Stationly deletes the sandbox and its disk. Snapshots taken from it stay."
      action="Delete sandbox"
      cancel="Keep sandbox"
      onConfirm={() => mutation.mutateAsync()}
      trigger={
        <ActionButton
          icon={Trash2}
          label="Delete"
          subject={sandbox.name}
          size={size}
          disabled={sandbox.status === 'deleting'}
        />
      }
    />
  )
}

export function DeleteSnapshot({ snapshot }: { snapshot: SandboxSnapshot }) {
  const label = snapshot.name ?? snapshot.id
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1['sandbox-snapshots']({
          id: snapshot.id,
        }).delete(undefined, idempotency()),
      ),
    invalidate: ['sandboxes'],
    success: () => `Snapshot ${label} deleted`,
  })

  return (
    <Confirm
      title={`Delete snapshot ${label}?`}
      description="Sandboxes forked from it keep their own disks."
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
