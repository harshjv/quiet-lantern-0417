import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Code } from '@/components/code'
import { RemoveButton } from '@/components/confirm'
import { Field } from '@/components/field'
import { ErrorState, PageHeader } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { QrCode } from '@/components/qr'
import { SixDigitCode } from '@/components/six-digit-code'
import { Time } from '@/components/time'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { authClient, authMessage, passkeysAvailable, passkeysQuery, sessionQuery } from '@/lib/auth'
import { commands } from '@/lib/commands'
import { done, useApiMutation } from '@/lib/mutation'
import { load, warm } from '@/lib/queries'
import { titled } from '@/lib/title'
import { toneOutline } from '@/lib/tone'
import { z } from '@/lib/zod'

export const Route = createFileRoute('/_app/account')({
  validateSearch: z.object({
    enroll: z.boolean().optional().catch(undefined),
  }),
  loader: async ({ context }) => {
    await Promise.all([
      load(context.queryClient, sessionQuery),
      passkeysAvailable() && warm(context.queryClient, passkeysQuery),
    ])
  },
  head: () => titled('Account'),
  errorComponent: failurePage('Couldn’t load your account'),
  component: Account,
})

function PasskeyList({
  onRemove,
  removing,
}: {
  onRemove: (id: string) => void
  removing: boolean
}) {
  const { data } = useSuspenseQuery(passkeysQuery)

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No passkeys yet.</p>
  }

  return (
    <ul className="divide-y rounded-md border">
      {data.map((p) => (
        <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{p.name ?? 'Unnamed passkey'}</span>
          <Badge variant="outline">
            {p.deviceType === 'multiDevice' ? 'Synced' : 'This device only'}
          </Badge>
          <Time value={p.createdAt} prefix="Added" className="text-muted-foreground" />
          <RemoveButton
            className="ml-auto"
            label={`Remove passkey ${p.name ?? ''}`}
            onClick={() => onRemove(p.id)}
            disabled={removing}
          />
        </li>
      ))}
    </ul>
  )
}

function Passkeys() {
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
          A passkey signs you in on its own. You also use it to approve{' '}
          <Code>{commands.login()}</Code> and agents that connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">
            Passkeys need the dashboard’s own hostname over HTTPS. Open it there to add one, or use
            TOTP on this address.
          </p>
        ) : (
          <>
            <Panel rows={1} title="Couldn’t load passkeys">
              <PasskeyList onRemove={(id) => remove.mutate(id)} removing={remove.isPending} />
            </Panel>
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

  const confirm = async (event?: FormEvent) => {
    event?.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.verifyTotp({
      code,
    })

    setBusy(false)

    if (result.error) {
      setError(authMessage(result.error, 'That code didn’t match. Check the app and try again.'))
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
      setError(authMessage(result.error, 'Stationly didn’t accept that password.'))

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
              On
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Once it’s on, password sign-in asks for a six-digit code. It works on every address, SSH
          forwards included.
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
  const { data: session } = useSuspenseQuery(sessionQuery)

  if (!session) {
    return (
      <ErrorState
        title="Your session ended"
        error={new Error('Sign in again to continue.')}
        action={
          <Button asChild size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
        }
      />
    )
  }

  const user = session.user

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account and sign-in" meta={<span>{user.email}</span>} />
      {enroll && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Add a passkey or TOTP</AlertTitle>
          <AlertDescription>
            Add one before you approve <Code>{commands.login()}</Code> or connect an agent.{' '}
            {passkeysAvailable()
              ? 'Either one protects this account beyond the password.'
              : 'Passkeys don’t work on this address, so set up TOTP.'}
          </AlertDescription>
        </Alert>
      )}
      <Passkeys />
      <Totp enabled={Boolean(user.twoFactorEnabled)} />
    </div>
  )
}
