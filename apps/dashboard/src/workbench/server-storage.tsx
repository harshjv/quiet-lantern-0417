import { useQueryClient } from '@tanstack/react-query'
import { HardDrive, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { gibibyte } from '@stationly/protocol/format'

import { Confirm } from '@/components/confirm'
import { Field, Suffixed } from '@/components/field'
import { FormError } from '@/components/form-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, idempotency, send } from '@/lib/api'
import { bytes } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'

import { Section } from './parts'
import type { ServerView } from './server-data'

const backingText = {
  device: 'its own disk',
  loop_file: 'a file on the host disk',
} as const

const growProblem = (size: number, current: number, max: number) => {
  if (!Number.isFinite(size) || size <= current) {
    return `Pick a size above the current ${bytes(current)}.`
  }

  if (size > max) {
    return `It can grow to ${bytes(max)} now.`
  }

  return null
}

export function MachineStorage({ server }: { server: ServerView }) {
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
          ['machine-storage'].grow.post(
            {
              size_bytes,
            },
            idempotency(),
          ),
      ),
    invalidate: ['stations'],
    waiting: () => `Growing machine storage on ${server.name}`,
    success: (body) => `Machine storage on ${server.name} is now ${bytes(body.filesystem_bytes)}`,
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
    <Section
      icon={HardDrive}
      title="Machine storage"
      note={`Machine disks live on ${backingText[storage.filesystem_backing]}: ${bytes(storage.filesystem_free_bytes)} free of ${bytes(storage.filesystem_bytes)}, and it can grow to ${bytes(storage.filesystem_max_bytes)} while machines run.`}
    >
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
    success: () => ({
      title: `${server.name} removed`,
      description: 'Its key is revoked, so it cannot connect again.',
    }),
    onSuccess: onRemoved,
  })

  return (
    <Section icon={Trash2} title="Remove">
      <div className="flex items-center justify-between gap-4 border p-3">
        <p className="text-sm text-muted-foreground">
          {server.status === 'enrolling'
            ? 'Cancels the pairing. Its command stops working.'
            : 'Revokes its key and disconnects it. Move its apps and delete its machines first.'}
        </p>
        <Confirm
          title={`Remove ${server.name}?`}
          description="Stationly revokes the server’s key, so it cannot connect again. To use the host again, add it as a new server."
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
