import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { CommandBlock } from '@/components/code'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { useNow } from '@/components/sandbox-clock'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, idempotency, send } from '@/lib/api'
import { span } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { secondsUntil } from '@/lib/sandbox'

import { Checklist, Notice, type Step } from './parts'
import { serversQuery } from './server-data'

type Pairing = { id: string; name: string; command: string; expiresAt: string }

function NameStep({
  onPaired,
  onOpenChange,
}: {
  onPaired: (pairing: Pairing) => void
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [intermittent, setIntermittent] = useState(false)
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1.servers.post(
          {
            name,
            intermittent,
          },
          idempotency(),
        ),
      ),
    invalidate: ['stations'],
    onSuccess: (result) => {
      if (!result.waiting) {
        onPaired({
          id: result.body.server.id,
          name: result.body.server.name,
          command: result.body.command,
          expiresAt: result.body.expires_at,
        })
      }
    },
  })

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Add a server"
      description="Name the server, then run one command on it. It pairs with this instance and takes apps and machines."
      error={mutation.errorText}
      submitLabel="Get the command"
      pending={mutation.isPending}
      submitDisabled={!name}
      onSubmit={() => mutation.mutate()}
    >
      <Field
        id="server-name"
        label="Name"
        hint="Lower case letters, digits and hyphens, such as gpu-1."
      >
        <SlugInput id="server-name" value={name} onValueChange={setName} placeholder="gpu-1" />
      </Field>
      <CheckboxField
        id="server-intermittent"
        checked={intermittent}
        onCheckedChange={setIntermittent}
        label="It sleeps at times, like a laptop or a workstation"
      />
    </FormDialog>
  )
}

function PairStep({
  pairing,
  onOpenChange,
}: {
  pairing: Pairing
  onOpenChange: (open: boolean) => void
}) {
  const { data } = useQuery(serversQuery)
  const now = useNow()
  const server = data?.items.find((item) => item.id === pairing.id)
  const paired = server !== undefined && server.status !== 'enrolling'
  const left = secondsUntil(pairing.expiresAt, now) ?? 0
  const expired = !paired && left <= 0
  const steps: Step[] = [
    {
      label: 'Command ready',
      state: 'done',
    },
    {
      label: paired ? `${pairing.name} connected` : `Waiting for ${pairing.name} to connect`,
      state: paired ? 'done' : expired ? 'failed' : 'now',
      time: paired || expired ? undefined : `${span(left)} left`,
    },
  ]

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pair {pairing.name}</DialogTitle>
          <DialogDescription>
            Run this as root on the new server after installing stationd. The command works once and
            holds a secret, so copy it now: Stationly shows it only here.
          </DialogDescription>
        </DialogHeader>
        <CommandBlock commands={pairing.command} />
        <Checklist steps={steps} />
        {expired && (
          <Notice tone="warning" title="The command expired">
            Remove {pairing.name} from the list and add it again for a new command.
          </Notice>
        )}
        <DialogFooter>
          <Button variant={paired ? 'default' : 'outline'} onClick={() => onOpenChange(false)}>
            {paired ? 'Done' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AddServer() {
  const [open, setOpen] = useState(false)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const close = (next: boolean) => {
    if (!next) {
      setOpen(false)
      setPairing(null)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> Add server
      </Button>
      {open &&
        (pairing ? (
          <PairStep pairing={pairing} onOpenChange={close} />
        ) : (
          <NameStep onPaired={setPairing} onOpenChange={close} />
        ))}
    </>
  )
}
