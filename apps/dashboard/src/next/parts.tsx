import {
  Activity,
  CircleAlert,
  Clock,
  ExternalLink,
  FileCode,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Server,
  Tag,
  User,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Message, MessageContent } from '@/components/ai-elements/message'
import { StateIcon, type State } from '@/components/state-icon'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toneBadge, tonePanel, toneText, type Tone } from '@/lib/tone'
import { cn } from '@/lib/utils'

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 font-mono text-xs font-normal', toneBadge[tone])}
    >
      <span className="size-1.5 bg-current" aria-hidden />
      {children}
    </Badge>
  )
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: Tone
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <Alert className={cn('flex items-start gap-3', tonePanel[tone])}>
      <CircleAlert className={cn('mt-0.5 size-4 shrink-0', toneText[tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <AlertTitle>{title}</AlertTitle>
        {children && <AlertDescription className="text-current/80">{children}</AlertDescription>}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </Alert>
  )
}

export type Step = { label: string; state: 'done' | 'now' | 'todo' | 'failed'; time?: string }

const stepState: Record<Step['state'], State> = {
  done: 'done',
  now: 'working',
  todo: 'queued',
  failed: 'failed',
}

export function Checklist({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-2 border p-4">
      {steps.map((step) => (
        <li
          key={step.label}
          className={cn(
            'flex items-center gap-3 text-sm',
            step.state === 'todo' && 'text-muted-foreground',
            step.state === 'failed' && toneText.danger,
          )}
        >
          <StateIcon state={stepState[step.state]} />
          <span className="flex-1">{step.label}</span>
          {step.time && (
            <span className="text-xs text-muted-foreground tabular-nums">{step.time}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

export function Section({
  icon: Icon,
  title,
  count,
  facts,
  action,
  note,
  children,
}: {
  icon?: LucideIcon
  title: string
  count?: number
  facts?: ReactNode
  action?: ReactNode
  note?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 font-mono text-xs tracking-wider text-muted-foreground uppercase">
          {Icon && <Icon className="size-3.5" aria-hidden />}
          {title}
        </h2>
        {count !== undefined && (
          <span className="border px-1.5 font-mono text-xs leading-5 tabular-nums">{count}</span>
        )}
        <span className="flex-1" aria-hidden />
        {facts}
        {action}
      </div>
      {note && <p className="max-w-prose text-sm text-muted-foreground">{note}</p>}
      {children}
    </section>
  )
}

export function IconTile({ icon: Icon, tone = 'neutral' }: { icon: LucideIcon; tone?: Tone }) {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center border bg-muted',
        tone === 'neutral' ? 'text-foreground' : toneText[tone],
      )}
    >
      <Icon className="size-4" />
    </span>
  )
}

export function ItemList({ children }: { children: ReactNode }) {
  return <Card className="gap-0 divide-y py-0">{children}</Card>
}

export function ItemRow({
  icon,
  tone,
  title,
  meta,
  action,
}: {
  icon: LucideIcon
  tone?: Tone
  title: ReactNode
  meta?: Fact[]
  action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <IconTile icon={icon} tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">{title}</div>
        {meta && <Facts facts={meta} />}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  )
}

export function Stats({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="grid grid-cols-3 divide-x border-t">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 px-4 py-3 first:pl-0">
          <span className="font-display text-lg leading-none tabular-nums">{item.value}</span>
          <span className="font-mono text-xs text-muted-foreground uppercase">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function PixelBars({
  values,
  tone,
  tall,
  max,
}: {
  values: number[]
  tone?: Tone
  tall?: boolean
  max?: number
}) {
  const top = max ?? Math.max(...values)

  return (
    <div className={cn('flex items-end gap-0.5', tall ? 'h-24' : 'h-8')} aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cn('flex-1', tone ? 'bg-current ' + toneText[tone] : 'bg-brand-4')}
          style={{
            height: `${Math.max(1, Math.round((v / top) * 8)) * 12.5}%`,
          }}
        />
      ))}
    </div>
  )
}

export function Meta({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 font-mono text-xs" aria-label={label}>
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{label}: </span>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export type FactKind =
  | 'via'
  | 'project'
  | 'user'
  | 'time'
  | 'files'
  | 'tests'
  | 'preview'
  | 'health'
  | 'app'
  | 'version'
  | 'branch'
  | 'link'

export type Fact = { kind: FactKind; text: string }

const fact: Record<FactKind, { icon: LucideIcon; label: string }> = {
  via: {
    icon: Workflow,
    label: 'Through',
  },
  project: {
    icon: Folder,
    label: 'Project',
  },
  user: {
    icon: User,
    label: 'Who',
  },
  time: {
    icon: Clock,
    label: 'When',
  },
  files: {
    icon: FileCode,
    label: 'Changes',
  },
  tests: {
    icon: FlaskConical,
    label: 'Tests',
  },
  preview: {
    icon: Globe,
    label: 'Preview',
  },
  health: {
    icon: Activity,
    label: 'Health',
  },
  app: {
    icon: Server,
    label: 'App',
  },
  version: {
    icon: Tag,
    label: 'Version',
  },
  branch: {
    icon: GitBranch,
    label: 'Branch',
  },
  link: {
    icon: ExternalLink,
    label: 'Link',
  },
}

export function Facts({ facts }: { facts: Fact[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
      {facts.map((f) => (
        <Meta key={f.kind + f.text} icon={fact[f.kind].icon} label={fact[f.kind].label}>
          {f.text}
        </Meta>
      ))}
    </div>
  )
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return <Card className="gap-0 px-6 py-2">{children}</Card>
}

export function SettingRow({
  label,
  why,
  children,
}: {
  label: string
  why?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-3 border-b py-4 last:border-b-0 sm:grid-cols-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        {why && <span className="text-xs text-muted-foreground">{why}</span>}
      </div>
      <div className="sm:col-span-2">{children}</div>
    </div>
  )
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex gap-1">
      {items.map((p) => (
        <span key={p} className="border px-1.5 font-mono text-xs">
          {p}
        </span>
      ))}
    </div>
  )
}

export function Person({ name, sub }: { name: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-6">
        <AvatarFallback className="text-xs">{name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-col">
        <span>{name}</span>
        {sub && <span className="font-mono text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  )
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <h1 className="font-display text-xl">{title}</h1>
      {children}
    </div>
  )
}

export function AgentSays({ children }: { children: ReactNode }) {
  return (
    <Message from="assistant">
      <MessageContent>{children}</MessageContent>
    </Message>
  )
}
