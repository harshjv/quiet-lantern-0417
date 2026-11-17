import { useQuery } from '@tanstack/react-query'
import { Check, CircleCheck, Loader2 } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { CommandBlock, Snippet } from '@/components/code'
import { Confirm } from '@/components/confirm'
import { Field } from '@/components/field'
import { Rows } from '@/components/page'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { checkPrompt, expiries, installSly, setup, type Expiry } from '@/lib/agents'
import { api, failureText, unwrap, type Project, type Token } from '@/lib/api'
import { commands, type Level, type TokenTarget } from '@/lib/commands'
import { ago, byName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { client, level, mcpClient, mcpClients, type McpClient } from '@/lib/labels'
import { done, useApiMutation } from '@/lib/mutation'
import { usePlace } from '@/lib/nav'
import { agentTokensQuery, apiOriginQuery, projectsQuery, withoutToken } from '@/lib/queries'
import { tonePanel, toneText } from '@/lib/tone'
import { useBecame, useMoment } from '@/lib/use-moment'
import { cn } from '@/lib/utils'

import { ItemList, ItemRow, Notice, Page, Section } from './parts'

const all = '*'

const levels = Object.keys(level) as Level[]

const tab = (id: McpClient) => (id === 'generic' ? 'Other' : mcpClient[id])

const named = (id: McpClient) => (id === 'generic' ? 'your MCP client' : mcpClient[id])

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const tokenTargets: Record<TokenTarget, string> = {
  '*': 'Production and previews',
  production: 'Production',
  previews: 'Previews',
}

const tokenName = (id: McpClient) => `mcp/${id}`

const tokenOf = (tokens: Token[] | undefined, id: McpClient) =>
  tokens?.find((token) => token.name === tokenName(id))

function Step({
  number,
  title,
  description,
  last,
  done,
  children,
}: {
  number: number
  title: string
  description?: ReactNode
  last?: boolean
  done?: boolean
  children: ReactNode
}) {
  return (
    <li className="relative flex gap-4">
      {!last && <span className="absolute top-8 bottom-0 left-3.5 w-px bg-border" aria-hidden />}
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center border bg-background font-mono text-xs tabular-nums',
          done && tonePanel.success,
        )}
      >
        {done ? <Check data-moment="check" className="size-3.5" aria-label="Done" /> : number}
      </span>
      <div className={cn('flex min-w-0 flex-1 flex-col gap-3', !last && 'pb-8')}>
        <div className="flex flex-col gap-0.5 pt-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </li>
  )
}

function Picker<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <Field id={id} label={label} labelClassName="text-xs text-muted-foreground">
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function ConnectionStatus({ id }: { id: McpClient }) {
  const tokens = useQuery({
    ...agentTokensQuery,
    refetchInterval: (query) => (tokenOf(query.state.data, id)?.last_used_at ? false : 3000),
  })
  const token = tokenOf(tokens.data, id)
  const who = named(id)

  if (token?.last_used_at) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm">
        <CircleCheck className={cn('size-4', toneText.success)} aria-hidden />
        <span className="font-medium">{capital(who)} is connected</span>
        <span className="text-muted-foreground">
          Last call <Time value={token.last_used_at} live />
        </span>
      </p>
    )
  }

  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {token
        ? `${capital(who)} has its token. Waiting for its first call…`
        : `Waiting for ${who} to connect…`}
    </p>
  )
}

function Revoke({ token }: { token: Token }) {
  const name = client(token.name)
  const revoke = useApiMutation({
    mutationFn: async () =>
      done(
        await unwrap(
          api.v1
            .tokens({
              id: token.id,
            })
            .delete(),
        ),
      ),
    seed: () => [withoutToken(token.id)],
    success: () => `${name} disconnected`,
  })

  return (
    <Confirm
      title={`Disconnect ${name}?`}
      description={`Stationly revokes its token, so ${name} loses access at once. Run sly mcp install again to reconnect it.`}
      action="Revoke token"
      cancel="Keep token"
      onConfirm={() => revoke.mutateAsync()}
      trigger={
        <Button variant="ghost" size="sm">
          Revoke
        </Button>
      }
    />
  )
}

const accessText = (scope: Token['scopes'][number], projectNames: Map<string, string>) =>
  scope.project_id === all
    ? `${level[scope.level].label} on every project`
    : `${level[scope.level].label} on ${tokenTargets[scope.target].toLowerCase()} of ${projectNames.get(scope.project_id) ?? scope.project_id}`

function ConnectedAgents({ projects, shown }: { projects: Project[]; shown: McpClient }) {
  const tokens = useQuery(agentTokensQuery)
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))

  if (tokens.isPending) {
    return <Rows count={2} />
  }

  if (tokens.error) {
    return (
      <Notice tone="danger" title="Couldn’t load connected agents">
        {failureText(tokens.error)}
      </Notice>
    )
  }

  if (tokens.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No agents connected yet. An agent appears here once you run sly mcp install for it.
      </p>
    )
  }

  return (
    <ItemList>
      {tokens.data.map((token) => (
        <div key={token.id} data-moment={token.name === tokenName(shown) ? 'agent' : undefined}>
          <ItemRow
            icon={entityIcon.agent}
            title={client(token.name)}
            meta={[
              ...token.scopes.map((scope) => ({
                kind: 'status' as const,
                text: accessText(scope, projectNames),
              })),
              {
                kind: 'time',
                text: token.last_used_at ? `Last used ${ago(token.last_used_at)}` : 'Never used',
              },
              ...(token.expires_at
                ? [
                    {
                      kind: 'time' as const,
                      text: `Expires ${ago(token.expires_at)}`,
                    },
                  ]
                : []),
            ]}
            action={<Revoke token={token} />}
          />
        </div>
      ))}
    </ItemList>
  )
}

function Setup({ projects, origin }: { projects: Project[]; origin: string }) {
  const place = usePlace()
  const [id, setId] = useState<McpClient>('claude-code')
  const [project, setProject] = useState(
    projects.find((p) => p.name === place.project)?.name ?? projects[0]?.name ?? all,
  )
  const [target, setTarget] = useState<TokenTarget>('*')
  const [access, setAccess] = useState<Level>('deploy')
  const [expiry, setExpiry] = useState<Expiry>('30d')
  const projectId = projects.find((p) => p.name === project)?.id ?? all
  const tokens = useQuery(agentTokensQuery)
  const connected = tokens.data && Boolean(tokenOf(tokens.data, id)?.last_used_at)
  const justConnected = useBecame(id, connected)
  const page = useRef<HTMLDivElement>(null)

  useMoment(page, justConnected, (timeline) =>
    timeline
      .from('[data-moment="check"]', {
        autoAlpha: 0,
        scale: 0.5,
      })
      .from('[data-moment="agent"]', {
        autoAlpha: 0,
        x: -12,
      }),
  )

  const install = (mcp: McpClient) =>
    commands.mcpInstall({
      client: mcp,
      project,
      target,
      level: access,
      ttl: expiry,
    })

  return (
    <div ref={page} className="flex flex-col gap-8">
      <ol>
        <Step
          number={1}
          title="Install sly on the agent’s computer"
          description="Skip this if sly version already works there."
        >
          <CommandBlock commands={installSly} caption="Run on the agent’s computer" />
        </Step>
        <Step
          number={2}
          title="Sign in"
          description="sly opens this dashboard. Approve the sign-in with your passkey or authenticator code."
        >
          <CommandBlock commands={commands.login(origin)} caption="Run on the agent’s computer" />
        </Step>
        <Step number={3} title="Add Stationly to your agent">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Picker
              id="agent-project"
              label="Project"
              value={project}
              options={[
                {
                  value: all,
                  label: 'All projects',
                },
                ...projects.map((p) => ({
                  value: p.name,
                  label: p.name,
                })),
              ]}
              onChange={(next) => {
                setProject(next)
                setTarget('*')
              }}
            />
            <Picker
              id="agent-target"
              label="Production or previews"
              value={target}
              disabled={project === all}
              options={(Object.keys(tokenTargets) as TokenTarget[]).map((value) => ({
                value,
                label: tokenTargets[value],
              }))}
              onChange={setTarget}
            />
            <Picker
              id="agent-access"
              label="Access"
              value={access}
              options={levels.map((l) => ({
                value: l,
                label: level[l].label,
              }))}
              onChange={setAccess}
            />
            <Picker
              id="agent-expiry"
              label="Expires after"
              value={expiry}
              options={expiries.map((e) => ({
                value: e.ttl,
                label: e.label,
              }))}
              onChange={setExpiry}
            />
          </div>
          <p className="text-xs text-muted-foreground">{level[access].hint}</p>
          <Tabs value={id} onValueChange={(value) => setId(value as McpClient)}>
            <TabsList>
              {mcpClients.map((c) => (
                <TabsTrigger key={c} value={c}>
                  {tab(c)}
                </TabsTrigger>
              ))}
            </TabsList>
            {mcpClients.map((c) => (
              <TabsContent key={c} value={c} className="mt-3 flex flex-col gap-3">
                <CommandBlock
                  commands={install(c)}
                  caption={
                    setup[c].inRepository ? 'Run in your repository' : 'Run on the agent’s computer'
                  }
                />
                <p className="text-sm text-muted-foreground">
                  {setup[c].after} The token stays in sly’s credentials file.
                </p>
                {setup[c].follow && (
                  <CommandBlock commands={setup[c].follow} caption="Run on the agent’s computer" />
                )}
                {setup[c].snippet && (
                  <Snippet
                    code={setup[c].snippet.code}
                    label="server definition"
                    caption={setup[c].snippet.caption}
                  />
                )}
              </TabsContent>
            ))}
          </Tabs>
          <p className="text-xs text-muted-foreground">
            Stationly marks logs, DNS names and machine output as untrusted when it sends them to
            your agent. Your agent should treat them as data.
          </p>
        </Step>
        <Step number={4} title="Check that it works" last done={connected}>
          <Snippet code={checkPrompt} label="prompt" caption="Ask your agent" prose />
          <ConnectionStatus id={id} />
        </Step>
      </ol>

      <Section
        title="Connected agents"
        note="Each agent has its own token. Revoke one to cut its access at once."
      >
        <ConnectedAgents projects={projects} shown={id} />
      </Section>

      <Section title="Other ways to connect">
        <div className="flex flex-col gap-6 border p-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-medium">Agents with a shell and no MCP</h3>
              <p className="text-sm text-muted-foreground">
                Create a token with the access above and pass it to sly as environment variables.
                sly prints the key once.
              </p>
            </div>
            <CommandBlock
              commands={[
                commands.createToken(
                  {
                    project: projectId,
                    target,
                    level: access,
                  },
                  expiry,
                ),
                'export STATIONLY_TOKEN=<key>',
                `export STATIONLY_API_URL=${origin}`,
              ]}
              caption="Run on the agent’s computer"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-medium">Clients without a shell</h3>
            <p className="text-sm text-muted-foreground">
              Not supported yet. sly mcp runs on the agent’s computer, so the client needs to start
              local commands.
            </p>
          </div>
        </div>
      </Section>
    </div>
  )
}

export function LiveConnect() {
  const projects = useQuery(projectsQuery)
  const origin = useQuery(apiOriginQuery)
  const error = projects.error ?? origin.error

  return (
    <Page title="Connect an agent">
      <p className="-mt-6 max-w-prose text-sm text-muted-foreground">
        Your agent deploys, reads logs and runs machines through the same API as this dashboard,
        with its own token limited to the project and access you pick.
      </p>
      {error ? (
        <Notice tone="danger" title="Couldn’t load agent setup">
          {failureText(error)}
        </Notice>
      ) : projects.data && origin.data ? (
        <Setup projects={projects.data.items.toSorted(byName)} origin={origin.data} />
      ) : (
        <Rows count={6} />
      )}
    </Page>
  )
}
