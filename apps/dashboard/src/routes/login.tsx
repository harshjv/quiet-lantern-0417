import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { KeyRound, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Code } from '@/components/code'
import { CheckboxField, Field } from '@/components/field'
import { Logo } from '@/components/logo'
import { SixDigitCode } from '@/components/six-digit-code'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  authClient,
  authMessage,
  passkeysAvailable,
  safeNext,
  serverPage,
  sessionQuery,
} from '@/lib/auth'
import { commands } from '@/lib/commands'

type Search = { next?: string }

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.next === 'string'
      ? {
          next: search.next,
        }
      : {},
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.query(sessionQuery)
    const next = safeNext(search.next)
    if (session && !(next && serverPage(next)))
      throw redirect({
        to: next ?? '/',
      })
  },
  component: Login,
})

function Login() {
  const { next } = Route.useSearch()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [backup, setBackup] = useState(false)
  const [trust, setTrust] = useState(false)
  const [busy, setBusy] = useState<null | 'passkey' | 'password' | 'totp'>(null)
  const [error, setError] = useState<string | null>(null)
  const passkeys = passkeysAvailable()

  const finish = async () => {
    await client.invalidateQueries({
      queryKey: ['auth'],
    })
    const target = safeNext(next)
    if (target && serverPage(target)) {
      window.location.assign(target)
      return
    }
    const session = await client.query(sessionQuery)
    const keys = passkeys
      ? await authClient.passkey.listUserPasskeys().then((r) => r.data ?? [])
      : []
    if (session && !session.user.twoFactorEnabled && keys.length === 0) {
      await navigate({
        to: '/account',
        search: {
          enroll: true,
        },
      })
      return
    }
    await navigate({
      to: target ?? '/',
    })
  }

  const withPasskey = async () => {
    setError(null)
    setBusy('passkey')
    const result = await authClient.signIn.passkey()
    setBusy(null)
    if (result.error) {
      setError(
        authMessage(result.error, 'Your passkey didn’t work. Try again or use your password.'),
      )
      return
    }
    await finish()
  }

  const withPassword = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy('password')
    const result = await authClient.signIn.email({
      email,
      password,
    })
    setBusy(null)
    if (result.error) {
      setError(authMessage(result.error, 'The email or password is wrong.'))
      return
    }
    if ((result.data as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
      setStep('totp')
      return
    }
    await finish()
  }

  const withCode = async (event?: FormEvent) => {
    event?.preventDefault()
    setError(null)
    setBusy('totp')
    const result = backup
      ? await authClient.twoFactor.verifyBackupCode({
          code: code.trim(),
          trustDevice: trust,
        })
      : await authClient.twoFactor.verifyTotp({
          code,
          trustDevice: trust,
        })
    setBusy(null)
    if (result.error) {
      setError(authMessage(result.error, 'That code didn’t match. Check the app and try again.'))
      setCode('')
      return
    }
    await finish()
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-base font-semibold tracking-tight">
        <Logo className="size-6" />
        Stationly
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{step === 'credentials' ? 'Sign in' : 'Two-factor code'}</h1>
          </CardTitle>
          <CardDescription>
            {step === 'credentials' ? (
              next && serverPage(next) ? (
                <>
                  Sign in to approve <Code>{commands.login()}</Code>.
                </>
              ) : (
                'Sign in as the instance admin.'
              )
            ) : backup ? (
              'Enter one of the backup codes you saved when you enrolled TOTP.'
            ) : (
              'Enter the six-digit code from your authenticator app.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {step === 'credentials' ? (
            <>
              {passkeys && (
                <>
                  <Button
                    type="button"
                    className="w-full"
                    size="lg"
                    onClick={() => void withPasskey()}
                    disabled={busy !== null}
                  >
                    {busy === 'passkey' ? <Loader2 className="animate-spin" /> : <KeyRound />}
                    Sign in with a passkey
                  </Button>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    or with a password
                    <span className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}
              <form className="space-y-3" onSubmit={(e) => void withPassword(e)}>
                <Field id="email" label="Email">
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field id="password" label="Password">
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button
                  type="submit"
                  variant={passkeys ? 'outline' : 'default'}
                  className="w-full"
                  size="lg"
                  disabled={busy !== null}
                >
                  {busy === 'password' && <Loader2 className="animate-spin" />}
                  Continue
                </Button>
              </form>
              {!passkeys && (
                <p className="text-xs text-muted-foreground">
                  Passkeys need the dashboard hostname over HTTPS. On this address sign in with your
                  password and TOTP code.
                </p>
              )}
            </>
          ) : (
            <form className="space-y-4" onSubmit={(e) => void withCode(e)}>
              {backup ? (
                <Field id="backup" label="Backup code">
                  <Input
                    id="backup"
                    autoComplete="one-time-code"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              ) : (
                <div className="flex justify-center">
                  <SixDigitCode
                    value={code}
                    onChange={setCode}
                    onComplete={() => void withCode()}
                    autoFocus
                  />
                </div>
              )}
              <CheckboxField
                id="trust"
                checked={trust}
                onCheckedChange={setTrust}
                label="Trust this browser for 30 days"
              />
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={busy !== null || (!backup && code.length < 6)}
              >
                {busy === 'totp' && <Loader2 className="animate-spin" />}
                Verify
              </Button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => {
                    setStep('credentials')
                    setCode('')
                    setError(null)
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => {
                    setBackup((b) => !b)
                    setCode('')
                  }}
                >
                  {backup ? 'Use the authenticator code' : 'Use a backup code'}
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
      <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
        Forgot your password? Reset it as root on the station host.
      </p>
    </main>
  )
}
