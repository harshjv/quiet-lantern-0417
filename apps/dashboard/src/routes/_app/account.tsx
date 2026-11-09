import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Loader2, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy'
import { ErrorState, Mono, PageHeader, Rows } from '@/components/page'
import { QrCode } from '@/components/qr'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { authClient, authMessage, passkeysAvailable, passkeysQuery, sessionQuery } from '@/lib/auth'
import { ago } from '@/lib/format'

export const Route = createFileRoute('/_app/account')({
  validateSearch: (search: Record<string, unknown>): { enroll?: boolean } => (search.enroll === true || search.enroll === 'true' ? { enroll: true } : {}),
  component: Account
})

function Passkeys() {
  const client = useQueryClient()
  const available = passkeysAvailable()
  const list = useQuery({ ...passkeysQuery, enabled: available })
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: async () => {
      const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined })
      if (result.error) throw new Error(authMessage(result.error, 'The passkey was not registered.'))
    },
    onSuccess: () => {
      setName('')
      void client.invalidateQueries({ queryKey: ['auth'] })
      toast.success('Passkey added', { description: 'It signs you in on its own, without the password.' })
    },
    onError: failure => toast.error('The passkey was not added', { description: failure.message })
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({ id })
      if (result.error) throw new Error(authMessage(result.error, 'The passkey was not removed.'))
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['auth'] })
      toast.success('Passkey removed')
    },
    onError: failure => toast.error('The passkey was not removed', { description: failure.message })
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
        <CardDescription>A passkey with user verification is a full sign-in. It also approves sly login and OAuth clients.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">Passkeys work only on the dashboard hostname over HTTPS. Open the dashboard there to add one; on this address use TOTP.</p>
        ) : (
          <>
            {list.isPending ? (
              <Rows count={1} />
            ) : list.isError ? (
              <ErrorState error={list.error} />
            ) : list.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No passkey is registered.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {list.data.map(p => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{p.name ?? 'Unnamed passkey'}</span>
                    <Badge variant="outline">{p.deviceType === 'multiDevice' ? 'synced' : 'device-bound'}</Badge>
                    <span className="text-muted-foreground">added {ago(p.createdAt)}</span>
                    <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove passkey ${p.name ?? ''}`} onClick={() => remove.mutate(p.id)} disabled={remove.isPending}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="passkey-name">Name</Label>
                <Input id="passkey-name" placeholder="Laptop" value={name} onChange={e => setName(e.target.value)} />
              </div>
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
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const begin = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.enable({ password })
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
    setSetup({ uri, secret: new URL(uri).searchParams.get('secret') ?? '', backupCodes: result.data.backupCodes })
  }

  const confirm = async (event?: FormEvent) => {
    event?.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.verifyTotp({ code })
    setBusy(false)
    if (result.error) {
      setError(authMessage(result.error, 'The code was not accepted.'))
      setCode('')
      return
    }
    setSetup(null)
    setCode('')
    await client.invalidateQueries({ queryKey: ['auth'] })
    toast.success('TOTP is on', { description: 'Password sign-in now asks for a code.' })
  }

  const disable = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const result = await authClient.twoFactor.disable({ password })
    setBusy(false)
    setPassword('')
    if (result.error) {
      setError(authMessage(result.error, 'The password was not accepted.'))
      return
    }
    await client.invalidateQueries({ queryKey: ['auth'] })
    toast.success('TOTP is off')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" aria-hidden /> Authenticator app (TOTP)
          {enabled && (
            <Badge variant="outline" className="border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300">
              on
            </Badge>
          )}
        </CardTitle>
        <CardDescription>Once on, password sign-in needs a six-digit code. It works on every address, including the SSH forward.</CardDescription>
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
                  <p className="text-muted-foreground">Store them now; each signs in once without the app.</p>
                  <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs" data-testid="backup-codes">
                    {setup.backupCodes.map(c => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            <form onSubmit={e => void confirm(e)} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="totp-code">Code from the app</Label>
                <InputOTP id="totp-code" maxLength={6} value={code} onChange={setCode} inputMode="numeric" pattern="^[0-9]+$" aria-label="Six-digit code" autoComplete="one-time-code">
                  <InputOTPGroup>
                    {Array.from({ length: 6 }, (_, i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button type="submit" disabled={busy || code.length < 6}>
                {busy && <Loader2 className="animate-spin" />}
                Turn on TOTP
              </Button>
            </form>
          </div>
        ) : (
          <form onSubmit={e => void (enabled ? disable(e) : begin(e))} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="totp-password">Password</Label>
              <Input id="totp-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
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
  if (session.isError || !session.data) return <ErrorState error={session.error ?? new Error('No session')} />
  const user = session.data.user
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account and sign-in" meta={<span>{user.email}</span>} />
      {enroll && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Add a passkey or TOTP</AlertTitle>
          <AlertDescription>
            {passkeysAvailable() ? 'Either one protects this account beyond the password.' : 'On this address passkeys are not available; set up TOTP.'} One of the two is required before sly login and OAuth
            clients can be approved.
          </AlertDescription>
        </Alert>
      )}
      <Passkeys />
      <Totp enabled={Boolean(user.twoFactorEnabled)} />
    </div>
  )
}
