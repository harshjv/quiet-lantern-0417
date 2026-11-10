import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { RemoveButton } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Field } from '@/components/field'
import { ErrorState, Mono, PageHeader, Rows } from '@/components/page'
import { QrCode } from '@/components/qr'
import { QueryState } from '@/components/query-state'
import { SixDigitCode } from '@/components/six-digit-code'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { authClient, authMessage, passkeysAvailable, passkeysQuery, sessionQuery } from '@/lib/auth'
import { ago } from '@/lib/format'
import { done, useApiMutation } from '@/lib/mutation'
import { toneOutline } from '@/lib/tone'

export const Route = createFileRoute('/_app/account')({
  validateSearch: (search: Record<string, unknown>): { enroll?: boolean } =>
    search.enroll === true || search.enroll === 'true'
      ? {
          enroll: true,
        }
      : {},
  component: Account,
})

function Passkeys() {
  const available = passkeysAvailable()
  const list = useQuery({
    ...passkeysQuery,
    enabled: available,
  })
  const [name, setName] = useState('')
  const add = useApiMutation({
    mutationFn: async () => {
      const result = await authClient.passkey.addPasskey({
        name: name.trim() || undefined,
      })
      if (result.error)
        throw new Error(authMessage(result.error, 'The passkey was not registered.'))
      return done(null)
    },
    invalidate: ['auth'],
    success: () => ({
      title: 'Passkey added',
      description: 'It signs you in on its own, without the password.',
    }),
    onSuccess: () => setName(''),
    failure: () => 'The passkey was not added',
  })
  const remove = useApiMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({
        id,
      })
      if (result.error) throw new Error(authMessage(result.error, 'The passkey was not removed.'))
      return done(null)
    },
    invalidate: ['auth'],
    success: () => 'Passkey removed',
    failure: () => 'The passkey was not removed',
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    add.mutate()
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden /> Passkeys
        </CardTitle>
        <CardDescription>
          A passkey with user verification is a full sign-in. It also approves sly login and OAuth
          clients.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">
            Passkeys work only on the dashboard hostname over HTTPS. Open the dashboard there to add
            one; on this address use TOTP.
          </p>
        ) : (
          <>
            <QueryState
              query={list}
              rows={1}
              isEmpty={(data) => data.length === 0}
              empty={<p className="text-sm text-muted-foreground">No passkey is registered.</p>}
            >
              {(data) => (
                <ul className="divide-y rounded-md border">
                  {data.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{p.name ?? 'Unnamed passkey'}</span>
                      <Badge variant="outline">
                        {p.deviceType === 'multiDevice' ? 'synced' : 'device-bound'}
                      </Badge>
                      <span className="text-muted-foreground">added {ago(p.createdAt)}</span>
                      <RemoveButton
                        className="ml-auto"
                        label={`Remove passkey ${p.name ?? ''}`}
                        onClick={() => remove.mutate(p.id)}
                        disabled={remove.isPending}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
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
                Add a passkey
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Totp({ enabled }: { enabled: boolean }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(
    null,
  )
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const begin = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.enable({
      password,
    })
    setBusy(false)
    setPassword('')
    if (result.error) {
      setError(authMessage(result.error, 'The password was not accepted.'))
      return
    }
    if (!('totpURI' in result.data)) {
      setError('Dispatch did not return a TOTP secret.')
      return
    }
    const uri = result.data.totpURI
    setSetup({
      uri,
      secret: new URL(uri).searchParams.get('secret') ?? '',
      backupCodes: result.data.backupCodes,
    })
  }

  const confirm = async (event?: FormEvent) => {
    event?.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.verifyTotp({
      code,
    })
    setBusy(false)
    if (result.error) {
      setError(authMessage(result.error, 'The code was not accepted.'))
      setCode('')
      return
    }
    setSetup(null)
    setCode('')
    await client.invalidateQueries({
      queryKey: ['auth'],
    })
    toast.success('TOTP is on', {
      description: 'Password sign-in now asks for a code.',
    })
  }

  const disable = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.disable({
      password,
    })
    setBusy(false)
    setPassword('')
    if (result.error) {
      setError(authMessage(result.error, 'The password was not accepted.'))
      return
    }
    await client.invalidateQueries({
      queryKey: ['auth'],
    })
    toast.success('TOTP is off')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" aria-hidden /> Authenticator app (TOTP)
          {enabled && (
            <Badge variant="outline" className={toneOutline.success}>
              on
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Once on, password sign-in needs a six-digit code. It works on every address, including the
          SSH forward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {setup ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row">
              <QrCode value={setup.uri} label="TOTP enrollment QR code" />
              <div className="min-w-0 space-y-3 text-sm">
                <p>Scan the code with your authenticator app, or enter the key by hand.</p>
                <p className="flex items-center gap-1">
                  <Mono className="break-all">{setup.secret}</Mono>
                  <CopyButton value={setup.secret} label="key" />
                </p>
                <div>
                  <p className="font-medium">Backup codes</p>
                  <p className="text-muted-foreground">
                    Store them now; each signs in once without the app.
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
            <form onSubmit={(e) => void confirm(e)} className="flex flex-wrap items-end gap-3">
              <Field id="totp-code" label="Code from the app">
                <SixDigitCode id="totp-code" value={code} onChange={setCode} />
              </Field>
              <Button type="submit" disabled={busy || code.length < 6}>
                {busy && <Loader2 className="animate-spin" />}
                Turn on TOTP
              </Button>
            </form>
          </div>
        ) : (
          <form
            onSubmit={(e) => void (enabled ? disable(e) : begin(e))}
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
      </CardContent>
    </Card>
  )
}

function Account() {
  const { enroll } = Route.useSearch()
  const session = useQuery(sessionQuery)
  if (session.isPending) return <Rows count={4} />
  if (session.isError || !session.data)
    return <ErrorState error={session.error ?? new Error('No session')} />
  const user = session.data.user
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account and sign-in" meta={<span>{user.email}</span>} />
      {enroll && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Add a passkey or TOTP</AlertTitle>
          <AlertDescription>
            {passkeysAvailable()
              ? 'Either one protects this account beyond the password.'
              : 'On this address passkeys are not available; set up TOTP.'}{' '}
            One of the two is required before sly login and OAuth clients can be approved.
          </AlertDescription>
        </Alert>
      )}
      <Passkeys />
      <Totp enabled={Boolean(user.twoFactorEnabled)} />
    </div>
  )
}
