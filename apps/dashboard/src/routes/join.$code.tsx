import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Field } from '@/components/field'
import { Logo } from '@/components/logo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { authClient, authMessage } from '@/lib/auth'
import { titled } from '@/lib/title'

type JoinInfo = { team: string; invited_by: string; role: 'admin' | 'member'; expires_at: string }

const joinUrl = (code: string) => `/v1/join/${encodeURIComponent(code)}`

const readJoin = async (code: string): Promise<JoinInfo | null> => {
  const reply = await fetch(joinUrl(code))

  return reply.ok ? ((await reply.json()) as JoinInfo) : null
}

const roleText = {
  admin: 'an admin',
  member: 'a member',
}

export const Route = createFileRoute('/join/$code')({
  head: () => titled('Join the team'),
  component: Join,
})

function Join() {
  const { code } = Route.useParams()
  const info = useQuery({
    queryKey: ['join', code],
    queryFn: () => readJoin(code),
    retry: false,
  })
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)

    const reply = await fetch(joinUrl(code), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name,
        email,
        password,
      }),
    })

    if (!reply.ok) {
      const body = (await reply.json().catch(() => null)) as {
        error?: { explanation?: string }
      } | null

      setBusy(false)
      setError(body?.error?.explanation ?? 'Stationly could not create your account.')

      return
    }

    const signedIn = await authClient.signIn.email({
      email,
      password,
    })

    if (signedIn.error) {
      setBusy(false)
      setError(authMessage(signedIn.error, 'Your account exists; sign in to continue.'))

      return
    }

    window.location.assign('/')
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
            <h1>Join the team</h1>
          </CardTitle>
          <CardDescription>
            {info.isPending
              ? 'Checking your invite…'
              : info.data
                ? `Invited by ${info.data.invited_by} to ${info.data.team} as ${roleText[info.data.role]}.`
                : 'This invite link is no longer valid. Ask for a new one.'}
          </CardDescription>
        </CardHeader>
        {info.data && (
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
              <Field id="join-name" label="Your name">
                <Input
                  id="join-name"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field id="join-email" label="Email">
                <Input
                  id="join-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field id="join-password" label="Password" hint="At least 12 characters.">
                <Input
                  id="join-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />} Join
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </main>
  )
}
