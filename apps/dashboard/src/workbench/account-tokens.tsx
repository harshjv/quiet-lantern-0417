import { useQuery } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'

import { CommandBlock } from '@/components/code'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Rows } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import { ago } from '@/lib/format'
import { done, useApiMutation } from '@/lib/mutation'
import { apiOriginQuery, personalTokensQuery } from '@/lib/queries'

import { ItemList, ItemRow, Notice, Section } from './parts'
import { RevokeToken } from './revoke-token'

const day = 86_400

const lifetimes = [
  {
    value: String(30 * day),
    label: '30 days',
  },
  {
    value: String(90 * day),
    label: '90 days',
  },
  {
    value: String(365 * day),
    label: '1 year',
  },
] as const

type Created = { name: string; key: string }

function CreateToken({ onCreated }: { onCreated: (created: Created) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState<string>(lifetimes[1].value)
  const create = useApiMutation({
    mutationFn: async () =>
      done(
        await unwrap(
          api.v1.tokens.post(
            {
              name: name.trim(),
              kind: 'personal',
              expires_in_s: Number(lifetime),
            },
            idempotency(),
          ),
        ),
      ),
    invalidate: ['tokens'],
    onSuccess: (result) => {
      if (!result.waiting) {
        setOpen(false)
        setName('')
        onCreated({
          name: result.body.name,
          key: result.body.key,
        })
      }
    },
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          create.reset()
        }
      }}
      trigger={
        <Button size="sm" variant="outline">
          <Plus /> Create token
        </Button>
      }
      title="Create a personal token"
      description="Full admin access for a script or CI job. Shown once."
      error={create.errorText}
      submitLabel="Create token"
      pending={create.isPending}
      submitDisabled={!name.trim()}
      onSubmit={() => create.mutate()}
    >
      <Field id="token-name" label="Name" hint="Where it runs.">
        <Input
          id="token-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="ci-deploy"
        />
      </Field>
      <Field id="token-lifetime" label="Expires after">
        <Select value={lifetime} onValueChange={setLifetime}>
          <SelectTrigger id="token-lifetime" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {lifetimes.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FormDialog>
  )
}

function ShownOnce({ created, onClose }: { created: Created; onClose: () => void }) {
  const origin = useQuery(apiOriginQuery)

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy the key now</DialogTitle>
          <DialogDescription>Shown only here. Set it where sly runs.</DialogDescription>
        </DialogHeader>
        <CommandBlock
          commands={[
            `export STATIONLY_TOKEN=${created.key}`,
            `export STATIONLY_API_URL=${origin.data ?? window.location.origin}`,
          ]}
        />
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PersonalTokens() {
  const tokens = useQuery(personalTokensQuery)
  const [created, setCreated] = useState<Created | null>(null)

  return (
    <Section
      title="Personal tokens"
      note="Full admin access for scripts and CI. Cannot approve changes."
      action={<CreateToken onCreated={setCreated} />}
    >
      {tokens.isPending ? (
        <Rows count={2} />
      ) : tokens.error ? (
        <Notice tone="danger" title="Couldn’t load personal tokens">
          {failureText(tokens.error)}
        </Notice>
      ) : tokens.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No personal tokens</p>
      ) : (
        <ItemList>
          {tokens.data.map((token) => (
            <ItemRow
              key={token.id}
              icon={KeyRound}
              title={token.name}
              meta={[
                {
                  kind: 'time',
                  text: `Expires ${ago(token.expires_at)}`,
                },
                {
                  kind: 'status',
                  text: token.last_used_at ? `Last used ${ago(token.last_used_at)}` : 'Never used',
                },
              ]}
              action={
                <RevokeToken
                  token={token}
                  title={`Revoke ${token.name}?`}
                  description="Anything that uses it loses access at once."
                  revoked={`Revoked ${token.name}`}
                />
              }
            />
          ))}
        </ItemList>
      )}
      {created && <ShownOnce created={created} onClose={() => setCreated(null)} />}
    </Section>
  )
}
