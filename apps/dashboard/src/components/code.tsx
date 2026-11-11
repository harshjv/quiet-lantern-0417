import { Link } from '@tanstack/react-router'
import { Terminal } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { CopyButton } from '@/components/copy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { placeholders, type Tool } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

const chip = 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground'

const replaceHint = (command: string) => {
  const names = placeholders(command)

  return names.length ? `Replace ${names.join(' and ')} before you run it.` : undefined
}

function Tokens({ command }: { command: string }) {
  return command.split(/(<[^<>]+>)/).map((part, i) =>
    /^<[^<>]+>$/.test(part) ? (
      <var key={i} className="text-amber-700 italic dark:text-amber-300">
        {part.slice(1, -1)}
      </var>
    ) : (
      part
    ),
  )
}

export function Code({
  children,
  copy,
  className,
}: {
  children: ReactNode
  copy?: string
  className?: string
}) {
  if (!copy) {
    return <code className={cn(chip, 'break-all', className)}>{children}</code>
  }

  return (
    <span className="group/code inline-flex max-w-full items-center gap-0.5 align-middle">
      <code className={cn(chip, 'truncate', className)}>{children}</code>
      <CopyButton
        value={copy}
        label={copy}
        className="opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
      />
    </span>
  )
}

export function Command({ command, className }: { command: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded bg-muted py-0.5 pr-0.5 pl-1.5 align-middle font-mono text-[0.8125rem] text-foreground',
        className,
      )}
    >
      <span className="text-muted-foreground select-none" aria-hidden>
        $
      </span>
      <code className="min-w-0 text-left [overflow-wrap:anywhere]">
        <Tokens command={command} />
      </code>
      <CopyButton value={command} label="command" hint={replaceHint(command)} />
    </span>
  )
}

function Frame({
  caption,
  copy,
  className,
  children,
  prose,
  ...props
}: ComponentProps<'div'> & {
  caption?: ReactNode
  copy: ReactNode
  prose?: boolean
}) {
  return (
    <div className={cn('overflow-hidden rounded-md border bg-muted/50', className)} {...props}>
      {caption && (
        <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">{caption}</div>
      )}
      <div className="flex items-start gap-2 px-3 py-2">
        <pre
          className={cn(
            'min-w-0 flex-1 leading-6 whitespace-pre-wrap',
            prose ? 'font-sans text-sm' : 'font-mono text-[0.8125rem] [overflow-wrap:anywhere]',
          )}
        >
          {children}
        </pre>
        <div className="mt-0.5">{copy}</div>
      </div>
    </div>
  )
}

export function CommandBlock({
  commands,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  commands: string | string[]
  caption?: ReactNode
}) {
  const lines = typeof commands === 'string' ? [commands] : commands
  const text = lines.join('\n')

  return (
    <Frame
      copy={
        <CopyButton
          value={text}
          label={lines.length > 1 ? 'commands' : 'command'}
          hint={replaceHint(text)}
        />
      }
      {...props}
    >
      {lines.map((line, i) => (
        <span key={i} className="block" data-testid="command">
          <span className="mr-2 text-muted-foreground select-none" aria-hidden>
            $
          </span>
          <Tokens command={line} />
        </span>
      ))}
    </Frame>
  )
}

export function Snippet({
  code,
  label,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  code: string
  label: string
  caption?: ReactNode
  prose?: boolean
}) {
  return (
    <Frame copy={<CopyButton value={code} label={label} />} {...props}>
      {code}
    </Frame>
  )
}

export function AlsoWith({
  cli,
  tool,
  className,
}: {
  cli?: string
  tool?: Tool
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground',
        className,
      )}
    >
      <span>Also with</span>
      {cli && (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Terminal className="size-3.5 shrink-0" aria-label="sly" />
          <Command command={cli} className="text-xs" />
        </span>
      )}
      {tool && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/agents"
              className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground"
            >
              <entityIcon.agent className="size-3.5 shrink-0" aria-label="Your agent" />
              <Code className="text-xs">{tool}</Code>
            </Link>
          </TooltipTrigger>
          <TooltipContent>Your agent’s tool for this. Connect an agent to use it.</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
