import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, KeyRound, LogOut } from 'lucide-react'
import { useState } from 'react'

import { Rows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isInstanceAdmin } from '@/lib/agent-session'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import { authClient, authMessage, sessionQuery, signOut } from '@/lib/auth'
import { plural } from '@/lib/format'
import { meQuery } from '@/lib/queries'

import { EnrollPrompt, Passkeys, Totp, useNeedsEnrollment } from './account-sign-in'
import { ItemList, ItemRow, Notice, Page, Section, StatusPill } from './parts'

function KeyRow({ name, set }: { name: string; set: boolean }) {
  const queries = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const refresh = () => {
    setEditing(false)
    setValue('')
    void queries.invalidateQueries({
      queryKey: ['me', 'keys'],
    })
  }
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1.me
          .keys({
            name,
          })
          .put(
            {
              value,
            },
            idempotency(),
          ),
      ),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1.me
          .keys({
            name,
          })
          .delete(undefined, idempotency()),
      ),
    onSuccess: refresh,
  })

  return (
    <ItemRow
      icon={KeyRound}
      tone={set ? 'neutral' : 'warning'}
      title={
        <>
          <span className="font-mono text-sm">{name}</span>
          <StatusPill tone={set ? 'success' : 'neutral'}>{set ? 'Set' : 'Not set'}</StatusPill>
        </>
      }
      meta={[]}
      action={
        editing ? (
          <span className="flex items-center gap-2">
            <Input
              type="password"
              autoFocus
              aria-label={`New value for ${name}`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button
              size="sm"
              disabled={!value.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant={set ? 'outline' : 'default'}
              onClick={() => setEditing(true)}
            >
              {set ? 'Replace' : 'Add'}
            </Button>
            {set && (
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            )}
          </span>
        )
      }
    />
  )
}

function LiveKeys() {
  const keys = useQuery({
    queryKey: ['me', 'keys'],
    queryFn: () => unwrap(api.v1.me.keys.get()),
  })

  return (
    <Section
      title="Your keys"
      note="Your tasks use your own key when you set one, and the project's key otherwise. Nobody else's task uses yours."
    >
      <ItemList>
        {(keys.data?.items ?? []).map((k) => (
          <KeyRow key={k.name} name={k.name} set={k.set} />
        ))}
      </ItemList>
    </Section>
  )
}

function GitHubConnection() {
  const queries = useQueryClient()
  const accounts = useQuery({
    queryKey: ['auth', 'accounts'],
    queryFn: async () => (await authClient.listAccounts()).data ?? [],
  })
  const repositories = useQuery({
    queryKey: ['me', 'repositories'],
    queryFn: () => unwrap(api.v1.me.repositories.get()),
  })
  const [problem, setProblem] = useState<string | null>(null)
  const linked = accounts.data?.find((entry) => entry.providerId === 'github')
  const connect = async () => {
    setProblem(null)
    const result = await authClient.linkSocial({
      provider: 'github',
      callbackURL: '/',
    })

    if (result.error) {
      setProblem(
        authMessage(
          result.error,
          `GitHub sign-in is not set up for this team. An admin connects the GitHub App, and adds ${window.location.origin}/auth/callback/github as a callback URL in its settings on GitHub.`,
        ),
      )
    }
  }
  const disconnect = async () => {
    if (!linked) {
      return
    }

    await authClient.unlinkAccount({
      accountId: linked.id,
    })
    void queries.invalidateQueries({
      queryKey: ['auth', 'accounts'],
    })
    void queries.invalidateQueries({
      queryKey: ['me', 'repositories'],
    })
  }

  return (
    <Section
      title="GitHub"
      note="Sign in with GitHub, and pick repositories you can reach when you start a task. Tasks still push with the project's token for now."
    >
      <ItemList>
        <ItemRow
          icon={GitBranch}
          tone={linked ? 'neutral' : 'warning'}
          title={linked ? 'GitHub is connected' : 'GitHub is not connected'}
          meta={
            linked
              ? [
                  {
                    kind: 'files',
                    text:
                      repositories.data?.github === 'reconnect'
                        ? 'GitHub refused the token; connect again'
                        : `${plural(repositories.data?.items.length ?? 0, 'repository', 'repositories')} you can reach`,
                  },
                ]
              : []
          }
          action={
            linked ? (
              <Button size="sm" variant="outline" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={() => void connect()}>
                Connect GitHub
              </Button>
            )
          }
        />
      </ItemList>
      {problem && (
        <Notice tone="warning" title="GitHub did not connect">
          {problem}
        </Notice>
      )}
    </Section>
  )
}

function GitHubApp() {
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const connection = useQuery({
    queryKey: ['github', 'connection'],
    queryFn: () => unwrap(api.v1.github.get()),
    enabled: admin,
  })

  if (!admin || !connection.data) {
    return null
  }

  const apps = connection.data.apps

  return (
    <Section
      title="GitHub App"
      note="Stationly reads, pushes and opens pull requests through this App, on the repositories it is installed on. Install it only where tasks should ship."
    >
      <ItemList>
        {apps.length === 0 ? (
          <ItemRow
            icon={GitBranch}
            tone="warning"
            title="No GitHub App connected"
            meta={[]}
            action={
              <Button asChild size="sm">
                <a href="/github/connect">Connect the GitHub App</a>
              </Button>
            }
          />
        ) : (
          apps.map((app) => (
            <ItemRow
              key={app.id}
              icon={GitBranch}
              tone={app.installation ? 'neutral' : 'warning'}
              title={
                <>
                  {app.slug}
                  <StatusPill tone={app.installation ? 'success' : 'warning'}>
                    {app.installation ? 'Installed' : 'Not installed'}
                  </StatusPill>
                </>
              }
              meta={
                app.installation
                  ? [
                      {
                        kind: 'user',
                        text: app.installation.account,
                      },
                      {
                        kind: 'files',
                        text:
                          app.installation.repository_selection === 'all'
                            ? 'Every repository of the account'
                            : 'Selected repositories',
                      },
                    ]
                  : []
              }
              action={
                <Button asChild size="sm" variant="outline">
                  <a href={app.install_url} target="_blank" rel="noreferrer">
                    {app.installation ? 'Change repositories' : 'Install'}
                  </a>
                </Button>
              }
            />
          ))
        )}
      </ItemList>
    </Section>
  )
}

function SignOut() {
  const client = useQueryClient()

  return (
    <Button size="sm" variant="outline" onClick={() => void signOut(client)}>
      <LogOut /> Sign out
    </Button>
  )
}

export function Account() {
  const session = useQuery(sessionQuery)
  const user = session.data?.user
  const needsEnrollment = useNeedsEnrollment(Boolean(user?.twoFactorEnabled))

  if (session.isPending) {
    return (
      <Page title="Your account">
        <Rows count={4} />
      </Page>
    )
  }

  if (!user) {
    return (
      <Page title="Your account">
        <Notice
          tone="warning"
          title="Your session ended"
          action={
            <Button asChild size="sm">
              <a href="/login">Sign in</a>
            </Button>
          }
        >
          {session.error ? failureText(session.error) : 'Sign in again to continue.'}
        </Notice>
      </Page>
    )
  }

  return (
    <Page title="Your account" actions={<SignOut />}>
      <p className="-mt-6 font-mono text-sm text-muted-foreground">{user.email}</p>
      {needsEnrollment && <EnrollPrompt />}
      <Passkeys />
      <Totp enabled={Boolean(user.twoFactorEnabled)} />
      <GitHubApp />
      <GitHubConnection />
      <LiveKeys />
    </Page>
  )
}
