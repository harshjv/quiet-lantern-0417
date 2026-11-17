import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Code } from '@/components/code'
import { RemoveButton } from '@/components/confirm'
import { Field } from '@/components/field'
import { Rows } from '@/components/page'
import { QrCode } from '@/components/qr'
import { SixDigitCode } from '@/components/six-digit-code'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authClient, authMessage, passkeysAvailable, passkeysQuery } from '@/lib/auth'
import { commands } from '@/lib/commands'
import { shortAgo } from '@/lib/format'
import { done, useApiMutation } from '@/lib/mutation'

import { ItemList, ItemRow, Notice, Section, StatusPill } from './parts'

export function useNeedsEnrollment(totp: boolean) {
  const available = passkeysAvailable()
  const passkeys = useQuery({
    ...passkeysQuery,
    enabled: available,
  })

  if (totp) {
    return false
  }

  return available ? passkeys.isSuccess && passkeys.data.length === 0 : true
}

export function EnrollPrompt() {
  return (
    <Notice tone="warning" title="Add a passkey or TOTP">
      <span className="inline">
        Add one before you approve <Code>{commands.login()}</Code> or connect an agent.{' '}
        {passkeysAvailable()
          ? 'Either one protects this account beyond the password.'
          : 'Passkeys don’t work on this address, so set up TOTP.'}
      </span>
    </Notice>
  )
}

function PasskeyRows() {
  const passkeys = useQuery(passkeysQuery)
  const remove = useApiMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({
        id,
      })

      if (result.error) {
        throw new Error(authMessage(result.error, 'Stationly couldn’t remove the passkey.'))
      }

      return done(null)
    },
    invalidate: ['auth'],
    success: () => 'Passkey removed',
    failure: () => 'remove the passkey',
  })

  if (passkeys.isPending) {
    return <Rows count={1} />
  }

  if (passkeys.error) {
    return (
      <Notice tone="danger" title="Couldn’t load passkeys">
        {passkeys.error.message}
      </Notice>
    )
  }

  if (passkeys.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No passkeys yet.</p>
  }

  return (
    <ItemList>
      {passkeys.data.map((p) => (
        <ItemRow
          key={p.id}
          icon={KeyRound}
          title={
            <>
              {p.name ?? 'Unnamed passkey'}
              <StatusPill tone="neutral">
                {p.deviceType === 'multiDevice' ? 'Synced' : 'This device only'}
              </StatusPill>
            </>
          }
          meta={
            p.createdAt
              ? [
                  {
                    kind: 'time',
                    text: `Added ${shortAgo(p.createdAt)}`,
                  },
                ]
              : []
          }
          action={
            <RemoveButton
              label={`Remove passkey ${p.name ?? ''}`}
              onClick={() => remove.mutate(p.id)}
              disabled={remove.isPending}
            />
          }
        />
      ))}
    </ItemList>
  )
}

export function Passkeys() {
  const available = passkeysAvailable()
  const [name, setName] = useState('')
  const add = useApiMutation({
    mutationFn: async () => {
      const result = await authClient.passkey.addPasskey({
        name: name.trim() || undefined,
      })

      if (result.error) {
        throw new Error(authMessage(result.error, 'Your browser didn’t create the passkey.'))
      }

      return done(null)
    },
    invalidate: ['auth'],
    success: () => ({
      title: 'Passkey added',
      description: 'It signs you in on its own, without the password.',
    }),
    onSuccess: () => setName(''),
    failure: () => 'add the passkey',
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    add.mutate()
  }

  return (
    <Section
      icon={KeyRound}
      title="Passkeys"
      note={`A passkey signs you in on its own. You also use it to approve ${commands.login()} and agents that connect.`}
    >
      {!available ? (
        <p className="text-sm text-muted-foreground">
          Passkeys need the dashboard’s own hostname over HTTPS. Open it there to add one, or use
          TOTP on this address.
        </p>
      ) : (
        <>
          <PasskeyRows />
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field id="passkey-name" label="Name" className="flex-1">
              <Input
                id="passkey-name"
                placeholder="Laptop"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Add passkey
            </Button>
          </form>
        </>
      )}
    </Section>
  )
}

type Setup = { uri: string; secret: string; backupCodes: string[] }

function TotpSetup({
  setup,
  busy,
  onConfirm,
}: {
  setup: Setup
  busy: boolean
  onConfirm: (code: string) => Promise<boolean>
}) {
  const [code, setCode] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (!(await onConfirm(code))) {
      setCode('')
    }
  }

  return (
    <div className="flex flex-col gap-4 border p-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <QrCode value={setup.uri} label="TOTP enrollment QR code" />
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <p>Scan the code with your authenticator app, or enter the key by hand.</p>
          <p>
            <Code copy={setup.secret}>{setup.secret}</Code>
          </p>
          <div>
            <p className="font-medium">Backup codes</p>
            <p className="text-muted-foreground">
              Save them now. Each one signs you in once without the app.
            </p>
            <ul
              className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs"
              data-testid="backup-codes"
            >
              {setup.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
        <Field id="totp-code" label="Code from the app">
          <SixDigitCode id="totp-code" value={code} onChange={setCode} />
        </Field>
        <Button type="submit" disabled={busy || code.length < 6}>
          {busy && <Loader2 className="animate-spin" />}
          Turn on TOTP
        </Button>
      </form>
    </div>
  )
}

export function Totp({ enabled }: { enabled: boolean }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [setup, setSetup] = useState<Setup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = () =>
    client.invalidateQueries({
      queryKey: ['auth'],
    })

  const begin = async () => {
    const result = await authClient.twoFactor.enable({
      password,
    })

    if (result.error) {
      setError(authMessage(result.error, 'Stationly didn’t accept that password.'))

      return
    }

    if (!('totpURI' in result.data)) {
      setError('Stationly didn’t return a TOTP secret. Try again.')

      return
    }

    const uri = result.data.totpURI

    setSetup({
      uri,
      secret: new URL(uri).searchParams.get('secret') ?? '',
      backupCodes: result.data.backupCodes,
    })
  }

  const disable = async () => {
    const result = await authClient.twoFactor.disable({
      password,
    })

    if (result.error) {
      setError(authMessage(result.error, 'Stationly didn’t accept that password.'))

      return
    }

    await refresh()
    toast.success('TOTP is off')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    await (enabled ? disable() : begin())
    setBusy(false)
    setPassword('')
  }

  const confirm = async (code: string) => {
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.verifyTotp({
      code,
    })

    setBusy(false)

    if (result.error) {
      setError(authMessage(result.error, 'That code didn’t match. Check the app and try again.'))

      return false
    }

    setSetup(null)
    await refresh()
    toast.success('TOTP is on', {
      description: 'Password sign-in now asks for a code.',
    })

    return true
  }

  return (
    <Section
      icon={ShieldCheck}
      title="Authenticator app (TOTP)"
      facts={
        <StatusPill tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</StatusPill>
      }
      note="Once it’s on, password sign-in asks for a six-digit code. It works on every address, SSH forwards included."
    >
      {error && (
        <Notice tone="danger" title="TOTP didn’t change">
          {error}
        </Notice>
      )}
      {setup ? (
        <TotpSetup setup={setup} busy={busy} onConfirm={confirm} />
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <Field id="totp-password" label="Password" className="flex-1">
            <Input
              id="totp-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant={enabled ? 'outline' : 'default'} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {enabled ? 'Turn off TOTP' : 'Set up TOTP'}
          </Button>
        </form>
      )}
    </Section>
  )
}
