import { Folder, GitBranch, Rocket } from 'lucide-react'
import type { ReactNode } from 'react'

import { Message, MessageContent } from '@/components/ai-elements/message'
import { Tool, ToolHeader } from '@/components/ai-elements/tool'
import { StateIcon, stateLabel } from '@/components/state-icon'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toneBadge, toneText, type Tone } from '@/lib/tone'
import { cn } from '@/lib/utils'

import {
  Checklist,
  Chips,
  ItemList,
  ItemRow,
  Meta,
  Notice,
  Person,
  PixelBars,
  Section,
  SettingRow,
  SettingsCard,
  Stats,
  StatusPill,
} from './parts'
import { ScreenMap } from './screens'
import { spaceScale, typeScale } from './tokens'

const radii = [
  ['rounded-none', 'Everything is square: buttons, inputs, cards, pills, dots, avatars, switches'],
] as const

const brand = [
  'bg-brand-1',
  'bg-brand-2',
  'bg-brand-3',
  'bg-brand-4',
  'bg-brand-5',
  'bg-brand-6',
] as const

const colors = [
  ['bg-background', 'background'],
  ['bg-card', 'card'],
  ['bg-muted', 'muted'],
  ['bg-accent', 'accent'],
  ['bg-primary', 'primary'],
  ['bg-secondary', 'secondary'],
  ['bg-destructive', 'destructive'],
  ['bg-border', 'border'],
] as const

const tones: [Tone, string][] = [
  ['info', 'Agent working'],
  ['warning', 'Needs a person'],
  ['success', 'Done, healthy'],
  ['danger', 'Failed'],
  ['neutral', 'Waiting its turn'],
  ['violet', 'Unused so far'],
]

const components: [string, string, () => ReactNode][] = [
  [
    'Page',
    'product: one width and one pixel title for every page outside the three modes, so the column never jumps between them',
    () => <span className="font-display text-xl">Team</span>,
  ],
  [
    'Chips',
    'product: a short list of names, such as projects or apps, in mono with square borders',
    () => <Chips items={['etherbit', 'yolo']} />,
  ],
  [
    'Person',
    'product: avatar initial, name and an optional mono second line, such as when they last did something',
    () => <Person name="Priya" sub="2h ago" />,
  ],
  [
    'Setting row',
    'product: label and why on the left, the control on the right; rows stack in a settings card',
    () => (
      <SettingsCard>
        <SettingRow label="Team name" why="Shown on invites and emails.">
          <span className="text-sm">Etherbit</span>
        </SettingRow>
      </SettingsCard>
    ),
  ],
  [
    'State icon',
    'components/state-icon: always on the left of the thing it describes; animated while in progress (spin for working, pulse for starting and waiting); still under reduced motion',
    () => (
      <div key="states" className="flex flex-wrap gap-4 font-mono text-xs">
        {(['working', 'pending', 'waiting', 'queued', 'done', 'failed', 'denied'] as const).map(
          (st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <StateIcon state={st} /> {stateLabel[st]}
            </span>
          ),
        )}
      </div>
    ),
  ],
  [
    'Meta',
    'product: icon + value, with the name of the value as a tooltip; never two bare values side by side',
    () => (
      <div key="meta" className="flex gap-4 text-sm text-muted-foreground">
        <Meta icon={Folder} label="Project">
          etherbit
        </Meta>
        <Meta icon={GitBranch} label="Branch">
          task/paise
        </Meta>
      </div>
    ),
  ],
  [
    'Stats',
    'product: pixel value over a mono label, three across; replaces sentences of numbers',
    () => (
      <Stats
        key="stats"
        items={[
          {
            value: '1.2k',
            label: 'req/h',
          },
          {
            value: '2h',
            label: 'deployed',
          },
          {
            value: 'v18',
            label: 'version',
          },
        ]}
      />
    ),
  ],
  [
    'Pixel bars',
    'product: trend in square steps of brand shade 4, or a tone when failing',
    () => <PixelBars key="bars" values={[4, 5, 3, 6, 7, 5, 8, 6, 7, 9, 7, 6]} />,
  ],
  [
    'Item row',
    'product: icon tile + title + meta + action, on shadcn card. Every list of things uses it',
    () => (
      <ItemList key="row">
        <ItemRow
          icon={Rocket}
          tone="warning"
          title="Ship a change to production"
          meta={[
            {
              kind: 'project',
              text: 'etherbit',
            },
            {
              kind: 'user',
              text: 'Priya',
            },
            {
              kind: 'time',
              text: '20m',
            },
          ]}
          action={<Button size="sm">Review</Button>}
        />
      </ItemList>
    ),
  ],
  [
    'Button',
    'shadcn button',
    () => (
      <div className="flex gap-2">
        <Button size="sm">Primary</Button>
        <Button size="sm" variant="outline">
          Outline
        </Button>
        <Button size="sm" variant="ghost">
          Ghost
        </Button>
        <Button size="sm" variant="destructive">
          Delete
        </Button>
      </div>
    ),
  ],
  [
    'Mode toggle',
    'shadcn toggle-group',
    () => (
      <ToggleGroup type="single" variant="outline" defaultValue="build">
        <ToggleGroupItem value="build">Build</ToggleGroupItem>
        <ToggleGroupItem value="ship">Ship</ToggleGroupItem>
        <ToggleGroupItem value="observe">Observe</ToggleGroupItem>
      </ToggleGroup>
    ),
  ],
  [
    'Status pill',
    'product, from shadcn badge + tone',
    () => (
      <div className="flex flex-wrap gap-2">
        <StatusPill tone="info">Working</StatusPill>
        <StatusPill tone="warning">Waiting on you</StatusPill>
        <StatusPill tone="success">Healthy</StatusPill>
        <StatusPill tone="danger">Failed</StatusPill>
        <StatusPill tone="neutral">Queued</StatusPill>
      </div>
    ),
  ],
  [
    'Notice',
    'product, from shadcn alert + tone',
    () => (
      <Notice tone="warning" title="Something needs you" action={<Button size="sm">Fix it</Button>}>
        What it blocks, in one line.
      </Notice>
    ),
  ],
  [
    'Checklist',
    'product, new: steps with timings',
    () => (
      <Checklist
        steps={[
          {
            label: 'Done step',
            state: 'done',
            time: '9s',
          },
          {
            label: 'Current step',
            state: 'now',
          },
          {
            label: 'Next step',
            state: 'todo',
          },
        ]}
      />
    ),
  ],
  [
    'Card',
    'shadcn card',
    () => (
      <Card className="w-56 gap-2">
        <CardHeader>
          <CardTitle>web</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">One plain sentence.</CardContent>
      </Card>
    ),
  ],
  [
    'Table',
    'shadcn table',
    () => (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Production</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-mono text-xs">DATABASE_URL</TableCell>
            <TableCell>Linked</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    ),
  ],
  [
    'Input, switch, kbd',
    'shadcn',
    () => (
      <div className="flex items-center gap-3">
        <Input placeholder="Search…" className="w-40" />
        <Switch defaultChecked />
        <Kbd>/</Kbd>
      </div>
    ),
  ],
  [
    'Avatar',
    'shadcn avatar',
    () => (
      <Avatar>
        <AvatarFallback>HV</AvatarFallback>
      </Avatar>
    ),
  ],
  ['Progress', 'shadcn progress', () => <Progress value={66} className="w-48" />],
  [
    'Message',
    'ai-elements message',
    () => (
      <Message from="user">
        <MessageContent>A message from you.</MessageContent>
      </Message>
    ),
  ],
  [
    'Tool call',
    'ai-elements tool',
    () => (
      <Tool className="w-80">
        <ToolHeader
          type="dynamic-tool"
          toolName="Bash"
          title="pnpm test"
          state="output-available"
        />
      </Tool>
    ),
  ],
]

export function Catalogue() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Design catalogue</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every screen uses only what is on this page. Before adding a new value or component, check
          whether one here already does the job; if none does, add it here first, with the reason.
        </p>
      </div>

      <Section title="Type" note="Geist, Geist Mono and Geist Pixel">
        <Card className="py-0">
          <Table>
            <TableBody>
              {typeScale.map(([cls, px, use]) => (
                <TableRow key={cls}>
                  <TableCell className={cn(cls, 'w-72')}>Ship to production</TableCell>
                  <TableCell className="font-mono text-xs">{cls}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{px}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{use}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="w-72 font-mono text-xs">task/integer-paise</TableCell>
                <TableCell className="font-mono text-xs">font-mono text-xs</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  Geist Mono: every second line, meta, pill, label, value, branch, command
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section title="Radius" note="none: --radius is 0 in the pixel theme">
        <div className="flex flex-wrap gap-4">
          {radii.map(([cls, use]) => (
            <div key={cls} className="flex w-36 flex-col gap-2">
              <div className={cn('h-14 border bg-muted', cls)} />
              <span className="font-mono text-xs">{cls}</span>
              <span className="text-xs text-muted-foreground">{use}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Colour" note="shadcn neutral tokens; both themes">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {colors.map(([cls, name]) => (
            <div key={cls} className="flex items-center gap-3">
              <span className={cn('size-8 border', cls)} />
              <span className="font-mono text-xs">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Brand" note="indigo, six shades; primary is shade 5; scenes use all six">
        <div className="grid grid-cols-6 gap-2">
          {brand.map((cls) => (
            <div key={cls} className="flex flex-col gap-2">
              <span className={cn('h-10 border', cls)} />
              <span className="font-mono text-xs">{cls.replace('bg-', '')}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tone" note="Status only, never decoration">
        <div className="grid gap-3 sm:grid-cols-3">
          {tones.map(([tone, use]) => (
            <div key={tone} className="flex items-center gap-3">
              <span className={cn('border px-2 text-xs', toneBadge[tone])}>{tone}</span>
              <span className={cn('text-sm', toneText[tone])}>{use}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Spacing"
        note="Tailwind's 4 px scale, these steps only. Lint rejects any other step, any font size off the type scale, rounded corners, raw colours, one-off values, inline styles other than data heights, and typed separators."
      >
        <Card className="py-0">
          <Table>
            <TableBody>
              {spaceScale.map(([step, px, use, width]) => (
                <TableRow key={step}>
                  <TableCell className="w-48">
                    <div className={cn('h-3 bg-primary', width)} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    gap-{step} p-{step}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{px}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{use}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section title="Components" note="where each comes from">
        <div className="flex flex-col gap-3">
          {components.map(([name, source, example]) => (
            <Card key={name} className="flex-row items-center gap-6 px-6">
              <div className="flex w-44 shrink-0 flex-col">
                <span className="text-sm font-medium">{name}</span>
                <span className="text-xs text-muted-foreground">{source}</span>
              </div>
              <div className="min-w-0 flex-1">{example()}</div>
            </Card>
          ))}
        </div>
      </Section>

      <ScreenMap />

      <Section title="Mock values mapped" note="what the HTML mock used, and the token it becomes">
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mock</TableHead>
                <TableHead>Becomes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ['11.5 px, 12 px, 12.5 px type', 'text-xs'],
                ['13 px, 13.5 px, 14 px type', 'text-sm'],
                ['15 px, 16 px type', 'text-base (rare)'],
                ['18 px, 20 px, 22 px, 26 px headings', 'text-lg, text-xl, text-2xl'],
                ['every radius, pills and dots included', 'square, rounded-none'],
                ['hand-mixed oklch status colours', 'lib/tone.ts tones'],
                ['status dots in raw palette colours', 'bg-current with toneText'],
              ].map(([a, b]) => (
                <TableRow key={a}>
                  <TableCell className="text-muted-foreground">{a}</TableCell>
                  <TableCell className="font-mono text-xs">{b}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>
    </div>
  )
}
