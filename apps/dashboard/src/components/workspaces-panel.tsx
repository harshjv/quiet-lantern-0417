import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { AgentStatusBadge } from '@/components/agent-status'
import { AlsoWith } from '@/components/code'
import { EmptyState, Section } from '@/components/page'
import { Panel } from '@/components/panel'
import { SandboxStatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { isInstanceAdmin } from '@/lib/agent-session'
import { sessionLink } from '@/lib/agent-sessions'
import type { AgentSession, Environment, Sandbox } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { ago } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery, meQuery, sandboxesQuery } from '@/lib/queries'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'

const linkClass =
  'flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none'

function WorkspaceLink({
  workspace,
  newest,
}: {
  workspace: Sandbox
  newest: AgentSession | undefined
}) {
  const content = (
    <>
      <entityIcon.workspace className="size-4 text-muted-foreground" aria-hidden />
      {workspace.name}
    </>
  )

  return newest ? (
    <Link
      to="/sessions/$sandbox/$session"
      params={sessionLink(newest)}
      className={linkClass}
      data-testid="workspace-link"
    >
      {content}
    </Link>
  ) : (
    <Link
      to="/sandboxes/$sandbox"
      params={{
        sandbox: workspace.id,
      }}
      className={linkClass}
      data-testid="workspace-link"
    >
      {content}
    </Link>
  )
}

function WorkspaceTable({ environment, scope }: { environment: Environment; scope: Scope }) {
  const { data } = useSuspenseQuery(sandboxesQuery(environment.id))
  const { data: me } = useQuery(meQuery)
  const admin = isInstanceAdmin(me?.scopes ?? [])
  const { data: sessions } = useQuery({
    ...agentSessionsQuery(),
    enabled: admin,
  })
  const workspaces = data.items.filter((sandbox) => sandbox.workspace)
  const fresh = useFresh(workspaces)

  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.workspace}
        title="No workspaces yet"
        description="A workspace is where an agent works: a machine with the agent installed and a repository cloned. Its sessions are on the Sessions page."
        also={<AlsoWith cli={commands.createWorkspace(scope)} tool="create_sandbox" />}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Workspace</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden sm:table-cell">Last activity</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {workspaces.map((workspace) => (
          <TableRow
            key={workspace.id}
            className={cn('relative', fresh.has(workspace.id) && highlight)}
          >
            <TableCell>
              <WorkspaceLink
                workspace={workspace}
                newest={sessions?.items.find((item) => item.sandbox.id === workspace.id)}
              />
            </TableCell>
            <TableCell className="text-muted-foreground">{workspace.workspace?.agent}</TableCell>
            <TableCell>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <SandboxStatusBadge status={workspace.status} reason={workspace.status_reason} />
                {workspace.status === 'running' && (
                  <AgentStatusBadge status={workspace.agent_status} />
                )}
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {workspace.agent_status?.last_event_at
                ? ago(workspace.agent_status.last_event_at)
                : 'No session yet'}
            </TableCell>
            <TableCell className="relative z-10 text-right">
              <Link
                to="/sandboxes/$sandbox"
                params={{
                  sandbox: workspace.id,
                }}
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                Machine
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

export function WorkspacesPanel({
  environment,
  project,
}: {
  environment: Environment
  project: string
}) {
  const scope = {
    project,
    environment: environment.name,
  }

  return (
    <Section
      title={<Term name="workspace">Workspaces</Term>}
      description="Where agents work. Open one to follow its sessions; Machine opens the sandbox underneath."
    >
      <Panel title="Couldn’t load workspaces">
        <WorkspaceTable environment={environment} scope={scope} />
      </Panel>
    </Section>
  )
}
