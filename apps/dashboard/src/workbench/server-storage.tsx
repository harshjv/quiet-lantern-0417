import { useQueryClient } from '@tanstack/react-query'
import { HardDrive, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { gibibyte } from '@stationly/protocol/format'

import { Confirm } from '@/components/confirm'
import { Field, Suffixed } from '@/components/field'
import { FormError } from '@/components/form-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { api, idempotency, send } from '@/lib/api'
import { bytes, usedOf } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'

import { Section } from './parts'
import type { ServerView } from './server-data'

const growProblem = (size: number, current: number, max: number) => {
  if (!Number.isFinite(size) || size <= current) {
    return `Pick a size above the current ${bytes(current)}.`
  }

  if (size > max) {
    return `It can grow to ${bytes(max)} now.`
  }

  return null
}

export function TaskStorage({ server }: { server: ServerView }) {
  const client = useQueryClient()
  const storage = server.capabilities?.sandboxes
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const grow = useApiMutation({
    mutationFn: (size_bytes: number) =>
      send(
        api.v1
          .servers({
            server: server.id,
          })
          ['task-storage'].grow.post(
            {
              size_bytes,
            },
            idempotency(),
          ),
      ),
    invalidate: ['stations'],
    waiting: () => `Growing task storage on ${server.name}`,
    success: (body) => `Task storage on ${server.name} is now ${bytes(body.filesystem_bytes)}`,
    onSuccess: () => {
      setText('')
      void client.invalidateQueries({
        queryKey: ['inventory'],
      })
    },
  })

  if (!storage) {
    return null
  }

  const used = storage.filesystem_bytes - storage.filesystem_free_bytes

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const size = Math.round(Number(text) * gibibyte)
    const found = growProblem(size, storage.filesystem_bytes, storage.filesystem_max_bytes)

    setProblem(found)

    if (!found) {
      grow.mutate(size)
    }
  }

  return (
    <Section icon={HardDrive} title="Task storage">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm tabular-nums">
          {usedOf(used, storage.filesystem_bytes)}{' '}
          <span className="text-xs text-muted-foreground">
            max {bytes(storage.filesystem_max_bytes)}
          </span>
        </span>
        <Progress
          value={Math.round((used / storage.filesystem_bytes) * 100)}
          aria-label={`Task storage ${usedOf(used, storage.filesystem_bytes)}`}
          className="h-1"
        />
      </div>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <FormError>{problem ?? grow.errorText}</FormError>
        <div className="flex items-end gap-3">
          <Field id={`grow-${server.id}`} label="New size" className="max-w-48">
            <Suffixed suffix="GiB">
              <Input
                id={`grow-${server.id}`}
                type="number"
                min={0}
                step="any"
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={String(Math.ceil(storage.filesystem_bytes / gibibyte) + 1)}
              />
            </Suffixed>
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={grow.isPending || storage.filesystem_bytes >= storage.filesystem_max_bytes}
          >
            Grow
          </Button>
        </div>
      </form>
    </Section>
  )
}

export function RemoveServer({ server, onRemoved }: { server: ServerView; onRemoved: () => void }) {
  const remove = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .servers({
            server: server.id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['stations'],
    success: () => `Removed ${server.name}`,
    onSuccess: onRemoved,
  })

  return (
    <Section icon={Trash2} title="Remove">
      <div className="flex items-center justify-between gap-4 border p-3">
        <p className="text-sm text-muted-foreground">
          {server.status === 'enrolling'
            ? 'Cancels the pairing. Its command stops working.'
            : 'Revokes its key. Move its apps and delete its tasks first.'}
        </p>
        <Confirm
          title={`Remove ${server.name}?`}
          description="Revokes its key for good. Add the host again as a new server."
          action="Remove server"
          cancel="Keep server"
          onConfirm={() => remove.mutateAsync()}
          trigger={
            <Button variant="outline" size="sm">
              <Trash2 /> Remove
            </Button>
          }
        />
      </div>
    </Section>
  )
}
