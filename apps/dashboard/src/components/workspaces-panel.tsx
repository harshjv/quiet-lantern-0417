import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { agentLabel } from '@stationly/protocol'

import { AlsoWith } from '@/components/code'
import { EmptyState, Section } from '@/components/page'
import { Panel } from '@/components/panel'
import { SandboxStatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Environment, Sandbox } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { sandboxesQuery } from '@/lib/queries'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'

const linkClass =
  'flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none'

function WorkspaceLink({ workspace }: { workspace: Sandbox }) {
  return (
    <Link
      to="/sandboxes/$sandbox"
      params={{
        sandbox: workspace.id,
      }}
      className={linkClass}
      data-testid="workspace-link"
    >
      <entityIcon.workspace className="size-4 text-muted-foreground" aria-hidden />
      {workspace.name}
    </Link>
  )
}

function WorkspaceTable({ environment, scope }: { environment: Environment; scope: Scope }) {
  const { data } = useSuspenseQuery(sandboxesQuery(environment.id))
  const workspaces = data.items.filter((sandbox) => sandbox.workspace)
  const fresh = useFresh(workspaces)

  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.workspace}
        title="No workspaces yet"
        description="A workspace is where an agent works: a machine with the agent installed and a repository cloned. Each task gets its own."
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
              <WorkspaceLink workspace={workspace} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {workspace.workspace && agentLabel(workspace.workspace.agent)}
            </TableCell>
            <TableCell>
              <SandboxStatusBadge status={workspace.status} reason={workspace.status_reason} />
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
      description="Where agents work. Each task runs in one; Machine opens the sandbox underneath."
    >
      <Panel title="Couldn’t load workspaces">
        <WorkspaceTable environment={environment} scope={scope} />
      </Panel>
    </Section>
  )
}
