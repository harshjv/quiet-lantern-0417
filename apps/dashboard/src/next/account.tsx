import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, GitBranch, KeyRound, Laptop, Mail, Terminal } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, idempotency, unwrap } from '@/lib/api'
import { authClient, authMessage } from '@/lib/auth'
import { plural } from '@/lib/format'

import { useLive } from './data'
import { yourKeys } from './fixtures'
import { devices, emailWhen } from './fixtures-outside'
import { ItemList, ItemRow, Notice, Page, Section, StatusPill } from './parts'

const keys = [
  {
    icon: KeyRound,
    name: 'Claude',
    set: yourKeys.claude,
    why: 'every Claude Code task you start',
  },
  {
    icon: Bot,
    name: 'Codex',
    set: yourKeys.codex,
    why: 'every Codex task you start',
  },
]

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
      callbackURL: '/next.html',
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

export function Account() {
  const live = useLive()

  return (
    <Page title="Your account">
      {live && <GitHubConnection />}
      {live ? (
        <LiveKeys />
      ) : (
        <Section
          title="Your keys"
          count={keys.length + 1}
          note="Tasks run on your own keys. Nobody else's task ever uses them, unless you invite someone to reply in yours."
        >
          <ItemList>
            {keys.map((k) => (
              <ItemRow
                key={k.name}
                icon={k.icon}
                tone={k.set ? 'neutral' : 'warning'}
                title={
                  <>
                    {k.name}
                    <StatusPill tone={k.set ? 'success' : 'warning'}>
                      {k.set ? 'Set' : 'Not set'}
                    </StatusPill>
                  </>
                }
                meta={[
                  {
                    kind: 'via',
                    text: k.why,
                  },
                ]}
                action={
                  k.set ? (
                    <>
                      <Button size="sm" variant="outline">
                        Replace
                      </Button>
                      <Button size="sm" variant="ghost">
                        Remove
                      </Button>
                    </>
                  ) : (
                    <Button size="sm">Add key</Button>
                  )
                }
              />
            ))}
            <ItemRow
              icon={GitBranch}
              title={
                <>
                  GitHub
                  <StatusPill tone="success">@harshjv</StatusPill>
                </>
              }
              meta={[
                {
                  kind: 'via',
                  text: 'your tasks clone and push as you',
                },
              ]}
              action={
                <Button size="sm" variant="outline">
                  Manage on GitHub
                </Button>
              }
            />
          </ItemList>
        </Section>
      )}

      <Section icon={Mail} title="Email me when">
        <Card className="gap-0 divide-y py-0">
          {emailWhen.map((e, i) => (
            <Label key={e.text} className="flex items-center gap-3 px-4 py-3 font-normal">
              <span className="flex-1 text-sm">{e.text}</span>
              <Switch id={`email-${i}`} defaultChecked={e.on} />
            </Label>
          ))}
        </Card>
      </Section>

      <Section title="Signed in" count={devices.length}>
        <ItemList>
          {devices.map((d) => (
            <ItemRow
              key={d.name}
              icon={d.name.startsWith('sly') ? Terminal : Laptop}
              title={
                <>
                  {d.name}
                  {d.current && <StatusPill tone="info">This device</StatusPill>}
                </>
              }
              meta={[
                {
                  kind: 'time',
                  text: d.used === 'now' ? 'active now' : `last used ${d.used}`,
                },
              ]}
              action={
                !d.current && (
                  <Button size="sm" variant="outline">
                    Sign out
                  </Button>
                )
              }
            />
          ))}
        </ItemList>
      </Section>

      <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
        Stationly 0.1.3-rc.9
        <span className="flex-1" />
        <Button size="sm" variant="outline">
          Sign out everywhere
        </Button>
      </div>
    </Page>
  )
}
