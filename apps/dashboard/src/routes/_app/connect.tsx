import { useQueries, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, CircleCheck, Loader2 } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { CommandBlock, Snippet } from '@/components/code'
import { Confirm } from '@/components/confirm'
import { Field } from '@/components/field'
import { EmptyState, PageHeader, Section } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { checkPrompt, expiries, installSly, setup, type Expiry } from '@/lib/agents'
import { api, unwrap, type Project, type Token } from '@/lib/api'
import { commands, type Level } from '@/lib/commands'
import { byName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { client, level, mcpClient, mcpClients, type McpClient } from '@/lib/labels'
import { done, useApiMutation } from '@/lib/mutation'
import {
  agentTokensQuery,
  apiOriginQuery,
  environmentQuery,
  environmentsQuery,
  load,
  projectsQuery,
  warm,
  withoutToken,
} from '@/lib/queries'
import { titled } from '@/lib/title'
import { tonePanel, toneText } from '@/lib/tone'
import { useBecame, useMoment } from '@/lib/use-moment'
import { cn } from '@/lib/utils'
import { z } from '@/lib/zod'

const all = '*'

const levels = Object.keys(level) as Level[]

const tab = (id: McpClient) => (id === 'generic' ? 'Other' : mcpClient[id])

const named = (id: McpClient) => (id === 'generic' ? 'your MCP client' : mcpClient[id])

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const Route = createFileRoute('/_app/connect')({
  validateSearch: z.object({
    project: z.string().optional().catch(undefined),
    client: z.literal(mcpClients).optional().catch(undefined),
  }),
  loader: ({ context }) =>
    Promise.all([
      load(context.queryClient, projectsQuery),
      load(context.queryClient, apiOriginQuery),
      warm(context.queryClient, agentTokensQuery),
    ]),
  head: () => titled('Connect an agent'),
  errorComponent: failurePage('Couldn’t load agent setup'),
  component: ConnectPage,
})

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
          'flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums',
          done && tonePanel.success,
        )}
      >
        {done ? <Check data-moment="check" className="size-3.5" aria-label="Done" /> : number}
      </span>
      <div className={cn('min-w-0 flex-1 space-y-3', !last && 'pb-8')}>
        <div className="space-y-0.5 pt-1">
          <h2 className="text-sm font-semibold">{title}</h2>
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

const tokenName = (id: McpClient) => `mcp/${id}`

const tokenOf = (tokens: Token[] | undefined, id: McpClient) =>
  tokens?.find((token) => token.name === tokenName(id))

function ConnectionStatus({ id }: { id: McpClient }) {
  const { data } = useSuspenseQuery({
    ...agentTokensQuery,
    refetchInterval: (query) => (tokenOf(query.state.data, id)?.last_used_at ? false : 3000),
  })
  const token = tokenOf(data, id)
  const who = named(id)

  if (token?.last_used_at) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm">
        <CircleCheck className={cn('size-4', toneText.success)} aria-hidden />
        <span className="font-medium">{capital(who)} is connected</span>
        <span className="text-muted-foreground">
          · last call <Time value={token.last_used_at} live />
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

function ConnectedAgents({ projects, shown }: { projects: Project[]; shown: McpClient }) {
  const { data } = useSuspenseQuery(agentTokensQuery)
  const environmentIds = [
    ...new Set(data.flatMap((token) => token.scopes.map((scope) => scope.environment_id))),
  ].filter((id) => id !== all)
  const environments = useQueries({
    queries: environmentIds.map((id) => environmentQuery(id)),
  })
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const environmentNames = new Map(
    environments.flatMap((e) => (e.data ? [[e.data.id, e.data.name] as const] : [])),
  )

  if (data.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.agent}
        title="No agents connected yet"
        description="An agent appears here once you run sly mcp install for it."
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead className="hidden sm:table-cell">Expires</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((token) => (
          <TableRow key={token.id}>
            <TableCell>
              <span
                data-moment={token.name === tokenName(shown) ? 'agent' : undefined}
                className="inline-flex items-center gap-2 font-medium"
              >
                <entityIcon.agent className="size-4 text-muted-foreground" aria-hidden />
                {client(token.name)}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {token.scopes.map((scope) => (
                <span key={`${scope.project_id}:${scope.environment_id}`} className="block">
                  {scope.project_id === all
                    ? 'All projects'
                    : (projectNames.get(scope.project_id) ?? scope.project_id)}
                  {' · '}
                  {scope.environment_id === all
                    ? 'all environments'
                    : (environmentNames.get(scope.environment_id) ?? scope.environment_id)}
                  {' · '}
                  {level[scope.level].label}
                </span>
              ))}
            </TableCell>
            <TableCell className="text-muted-foreground">
              <Time value={token.last_used_at} />
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              <Time value={token.expires_at} />
            </TableCell>
            <TableCell className="text-right">
              <Revoke token={token} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function ConnectPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })
  const { data: projectPage } = useSuspenseQuery(projectsQuery)
  const { data: origin } = useSuspenseQuery(apiOriginQuery)
  const projects = projectPage.items.toSorted(byName)
  const id = search.client ?? 'claude-code'
  const [project, setProject] = useState(
    projects.find((p) => p.name === search.project)?.name ?? projects[0]?.name ?? all,
  )
  const [environment, setEnvironment] = useState(all)
  const [access, setAccess] = useState<Level>('deploy')
  const [expiry, setExpiry] = useState<Expiry>('30d')
  const environments = useQuery({
    ...environmentsQuery(project),
    enabled: project !== all,
  })
  const projectId = projects.find((p) => p.name === project)?.id ?? all
  const environmentId = environments.data?.items.find((e) => e.name === environment)?.id ?? all
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
  const install = (target: McpClient) =>
    commands.mcpInstall({
      client: target,
      project,
      environment: environment === all ? null : environment,
      level: access,
      ttl: expiry,
    })

  return (
    <div ref={page} className="max-w-3xl space-y-10">
      <PageHeader
        title="Connect an agent"
        meta={
          <span>
            Your agent deploys, reads logs and runs sandboxes through the same API as this
            dashboard, with its own token limited to the project and access you pick.
          </span>
        }
      />
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
                setEnvironment(all)
              }}
            />
            <Picker
              id="agent-environment"
              label="Environment"
              value={environment}
              disabled={project === all}
              options={[
                {
                  value: all,
                  label: 'All environments',
                },
                ...(environments.data?.items ?? []).toSorted(byName).map((e) => ({
                  value: e.name,
                  label: e.name,
                })),
              ]}
              onChange={setEnvironment}
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
          <Tabs
            value={id}
            onValueChange={(value) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  client: value as McpClient,
                }),
                replace: true,
              })
            }
          >
            <TabsList>
              {mcpClients.map((c) => (
                <TabsTrigger key={c} value={c}>
                  {tab(c)}
                </TabsTrigger>
              ))}
            </TabsList>
            {mcpClients.map((c) => (
              <TabsContent key={c} value={c} className="mt-3 space-y-3">
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
            Stationly marks logs, DNS names and sandbox output as untrusted when it sends them to
            your agent. Your agent should treat them as data.
          </p>
        </Step>
        <Step number={4} title="Check that it works" last done={connected}>
          <Snippet code={checkPrompt} label="prompt" caption="Ask your agent" prose />
          <Panel rows={1} title="Couldn’t check the connection">
            <ConnectionStatus id={id} />
          </Panel>
        </Step>
      </ol>
      <Section
        title="Connected agents"
        description="Each agent has its own token. Revoke one to cut its access at once."
      >
        <Panel rows={2} title="Couldn’t load connected agents">
          <ConnectedAgents projects={projects} shown={id} />
        </Panel>
      </Section>
      <Section title="Other ways to connect">
        <div className="space-y-6 rounded-lg border p-4">
          <div className="space-y-3">
            <div className="space-y-0.5">
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
                    environment: environmentId,
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
          <div className="space-y-0.5">
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
