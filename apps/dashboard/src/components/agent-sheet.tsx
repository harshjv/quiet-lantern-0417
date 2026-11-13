import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

import { Code, CommandBlock, Snippet } from '@/components/code'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import type { Hint } from '@/lib/agent-hints'
import { commands, type Scope } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { client } from '@/lib/labels'
import { agentTokensQuery } from '@/lib/queries'

function Connected({ project }: { project: string }) {
  const tokens = useQuery(agentTokensQuery)
  const names = [...new Set((tokens.data ?? []).map((token) => client(token.name)))]
  const link = (
    <Link
      to="/connect"
      search={{
        project,
      }}
      className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
    >
      {names.length ? 'Manage agents' : 'Connect an agent'}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  )

  if (tokens.isPending) {
    return null
  }

  if (names.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Connected: {names.join(', ')}. {link}
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
      <p className="font-medium">No agent connected yet</p>
      <p className="text-muted-foreground">
        With sly installed and signed in, this adds Stationly to Claude Code for {project}.
      </p>
      <CommandBlock
        commands={commands.mcpInstall({
          client: 'claude-code',
          project,
          environment: null,
          level: 'deploy',
          ttl: '30d',
        })}
        caption="Run in your repository"
      />
      {link}
    </div>
  )
}

export function AgentSheet<S extends Scope>({ hint, scope }: { hint: Hint<S>; scope: S }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <entityIcon.agent aria-hidden />
          Agent
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Do this with your agent</SheetTitle>
          <SheetDescription>
            Paste the prompt into an agent that has Stationly connected.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 p-4">
          <Connected project={scope.project} />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Ask your agent</h3>
            <Snippet code={hint.prompt(scope)} label="prompt" prose />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Tools it uses</h3>
            <ul className="flex flex-wrap gap-1.5">
              {hint.tools.map((tool) => (
                <li key={tool}>
                  <Code>{tool}</Code>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Or run it yourself</h3>
            <CommandBlock commands={hint.command(scope)} caption="Run on your computer" />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
