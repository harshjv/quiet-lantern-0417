import { Gauge, SlidersHorizontal } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { gibibyte } from '@stationly/protocol/format'

import { Field, Suffixed } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, idempotency, send } from '@/lib/api'
import { useApiMutation } from '@/lib/mutation'

import { Section } from './parts'
import { patchServer, type ServerView } from './server-data'

type ServerChange = NonNullable<Parameters<ReturnType<typeof api.v1.servers>['patch']>[0]>

type TaskLimits = ServerView['machine_limits']

const useServerUpdate = (server: ServerView) =>
  useApiMutation({
    mutationFn: (body: ServerChange) =>
      send(
        api.v1
          .servers({
            server: server.id,
          })
          .patch(body, idempotency()),
      ),
    optimistic: (body) =>
      patchServer(server.id, {
        ...body,
        machine_limits: {
          ...server.machine_limits,
          ...body.machine_limits,
        },
      } as Partial<ServerView>),
    invalidate: ['stations'],
    waiting: () => `The change to ${server.name}`,
    success: () => `Saved ${server.name}`,
    failure: () => `change ${server.name}`,
  })

const gibText = (value: number | null) => (value === null ? '' : String(value / gibibyte))

const gibValue = (text: string) => (text.trim() === '' ? null : Math.round(Number(text) * gibibyte))

function SaveRow({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  return (
    <div>
      <Button type="submit" size="sm" disabled={pending || disabled}>
        Save
      </Button>
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 border p-3">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

export function Placement({ server }: { server: ServerView }) {
  const update = useServerUpdate(server)
  const [cap, setCap] = useState(String(server.concurrency_cap))
  const change: ServerChange = {
    ...(Number(cap) !== server.concurrency_cap
      ? {
          concurrency_cap: Number(cap),
        }
      : {}),
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    update.mutate(change)
  }

  return (
    <Section icon={SlidersHorizontal} title="Placement">
      <Toggle
        id={`draining-${server.id}`}
        label="Draining"
        hint="New deployments go elsewhere. Running apps stay."
        checked={server.draining}
        disabled={server.status === 'enrolling'}
        onChange={(draining) =>
          update.mutate({
            draining,
          })
        }
      />
      <Toggle
        id={`intermittent-${server.id}`}
        label="Sleeps at times"
        hint="Shown as asleep, not offline, when heartbeats stop."
        checked={server.intermittent}
        onChange={(intermittent) =>
          update.mutate({
            intermittent,
          })
        }
      />
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field id={`cap-${server.id}`} label="Deployments at once">
          <Input
            id={`cap-${server.id}`}
            type="number"
            min={1}
            step={1}
            required
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </Field>
        <SaveRow pending={update.isPending} disabled={Object.keys(change).length === 0} />
      </form>
    </Section>
  )
}

export function Limits({ server }: { server: ServerView }) {
  const update = useServerUpdate(server)
  const limits = server.machine_limits
  const [maxTasks, setMaxTasks] = useState(String(limits.max_machines))
  const [maxRunning, setMaxRunning] = useState(String(limits.max_running))
  const [memory, setMemory] = useState(gibText(limits.memory_bytes))
  const [minFree, setMinFree] = useState(gibText(limits.min_free_bytes))
  const wanted: TaskLimits = {
    max_machines: Number(maxTasks),
    max_running: Number(maxRunning),
    memory_bytes: gibValue(memory),
    min_free_bytes: gibValue(minFree),
  }
  const changed = Object.fromEntries(
    Object.entries(wanted).filter(([key, value]) => limits[key as keyof TaskLimits] !== value),
  ) as Partial<TaskLimits>
  const submit = (event: FormEvent) => {
    event.preventDefault()
    update.mutate({
      machine_limits: changed,
    })
  }
  const limitField = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    unit?: string,
  ) => {
    const input = (
      <Input
        id={id}
        type="number"
        min={0}
        step={unit ? 'any' : 1}
        required={!unit}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={unit ? 'No limit' : undefined}
      />
    )

    return (
      <Field id={id} label={label}>
        {unit ? <Suffixed suffix={unit}>{input}</Suffixed> : input}
      </Field>
    )
  }

  return (
    <Section icon={Gauge} title="Task slots">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        {limitField(`max-tasks-${server.id}`, 'Tasks in all', maxTasks, setMaxTasks)}
        {limitField(`max-running-${server.id}`, 'Running at once', maxRunning, setMaxRunning)}
        {limitField(`memory-${server.id}`, 'Memory for tasks', memory, setMemory, 'GiB')}
        {limitField(`min-free-${server.id}`, 'Keep free on the host', minFree, setMinFree, 'GiB')}
        <SaveRow pending={update.isPending} disabled={Object.keys(changed).length === 0} />
      </form>
    </Section>
  )
}
