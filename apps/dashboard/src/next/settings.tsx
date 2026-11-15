import {
  GitBranch,
  KeyRound,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Ticket,
  Webhook,
} from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { places, teamKeys, tokens } from './fixtures-outside'
import { Chips, ItemList, ItemRow, Page, Person, Section, SettingRow, SettingsCard } from './parts'

type Tab = 'general' | 'github' | 'keys' | 'tokens' | 'notifications'

const tabs: { id: Tab; title: string }[] = [
  {
    id: 'general',
    title: 'General',
  },
  {
    id: 'github',
    title: 'GitHub',
  },
  {
    id: 'keys',
    title: 'Team keys',
  },
  {
    id: 'tokens',
    title: 'Tokens',
  },
  {
    id: 'notifications',
    title: 'Notifications',
  },
]

function General() {
  return (
    <SettingsCard>
      <SettingRow label="Team name" why="Shown on invites and emails.">
        <Input defaultValue="Etherbit" />
      </SettingRow>
      <SettingRow label="Address" why="Where people open Stationly.">
        <div className="flex flex-col gap-2">
          <Input defaultValue="dash.try.stationly.harshjv.com" className="font-mono text-xs" />
          <span className="text-xs text-muted-foreground">
            Apps get links under{' '}
            <code className="font-mono text-xs">*.try.stationly.harshjv.com</code>.
          </span>
        </div>
      </SettingRow>
      <SettingRow label="Tasks at once" why="How many tasks a project's machine runs together.">
        <div className="flex flex-col gap-2">
          <Input defaultValue="3" className="w-24 font-mono text-xs" />
          <span className="text-xs text-muted-foreground">
            Suggested from your servers&apos; memory. Each project can lower it.
          </span>
        </div>
      </SettingRow>
      <SettingRow
        label="Pause idle tasks after"
        why="Keeps their files; the next reply wakes them."
      >
        <Select defaultValue="30">
          <SelectTrigger className="w-40" aria-label="Pause idle tasks after">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10 minutes</SelectItem>
            <SelectItem value="30">30 minutes</SelectItem>
            <SelectItem value="120">2 hours</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsCard>
  )
}

function GitHubSettings() {
  return (
    <SettingsCard>
      <SettingRow label="Stationly GitHub app">
        <div className="flex flex-col items-start gap-2">
          <span className="flex items-center gap-2 text-sm">
            <GitBranch className="size-4" /> Installed on harshjv with 3 repositories
          </span>
          <Button size="sm" variant="outline">
            Change repositories on GitHub
          </Button>
        </div>
      </SettingRow>
      <SettingRow label="Pull requests" why="Its preview link is posted on the pull request.">
        <label className="flex items-center gap-3 text-sm">
          <Switch defaultChecked /> Make a preview for every pull request
        </label>
      </SettingRow>
      <SettingRow label="Merges to main" why="Nothing reaches production without an approval.">
        <label className="flex items-center gap-3 text-sm">
          <Switch defaultChecked /> Open an approval for production
        </label>
      </SettingRow>
      <SettingRow
        label="Disconnect"
        why="No task can clone or push, and pull requests stop making previews."
      >
        <Button size="sm" variant="destructive">
          Disconnect GitHub
        </Button>
      </SettingRow>
    </SettingsCard>
  )
}

function TeamKeys() {
  return (
    <Section
      icon={KeyRound}
      title="Team keys"
      count={teamKeys.length}
      note="Keys the whole team uses across projects, such as an email service. A project only sees a team key you give it."
      action={
        <Button size="sm">
          <Plus /> Add team key
        </Button>
      }
    >
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Given to</TableHead>
              <TableHead>Previews</TableHead>
              <TableHead>Last set by</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {teamKeys.map((k) => (
              <TableRow key={k.key}>
                <TableCell className="font-mono text-xs font-medium">{k.key}</TableCell>
                <TableCell>
                  <Chips items={k.projects} />
                </TableCell>
                <TableCell className="text-sm">{k.previews}</TableCell>
                <TableCell>
                  <Person name={k.setBy} sub={k.age} />
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label={`Actions for ${k.key}`}>
                    <MoreHorizontal />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Section>
  )
}

function Tokens() {
  return (
    <Section
      icon={Ticket}
      title="Tokens"
      count={tokens.length}
      note="For scripts and CI that call Stationly. Assistants like Claude connect under Assistants instead."
      action={
        <Button size="sm">
          <Plus /> New token
        </Button>
      }
    >
      <ItemList>
        {tokens.map((t) => (
          <ItemRow
            key={t.name}
            icon={Ticket}
            title={t.name}
            meta={[
              {
                kind: 'via',
                text: t.can,
              },
              {
                kind: 'time',
                text: `expires ${t.expires}`,
              },
              {
                kind: 'health',
                text: `used ${t.used}`,
              },
            ]}
            action={
              <Button size="sm" variant="outline">
                Revoke
              </Button>
            }
          />
        ))}
      </ItemList>
    </Section>
  )
}

function Notifications() {
  return (
    <Section
      title="Where Stationly posts"
      count={places.length}
      note="Team-wide places. Each person chooses their own emails under Your account."
      action={
        <Button size="sm">
          <Plus /> Add a place
        </Button>
      }
    >
      <ItemList>
        {places.map((p) => (
          <ItemRow
            key={p.name}
            icon={p.name.startsWith('Slack') ? MessageSquare : Webhook}
            title={p.name}
            meta={[
              {
                kind: 'via',
                text: p.what,
              },
            ]}
            action={
              <Button size="sm" variant="outline">
                Send a test
              </Button>
            }
          />
        ))}
      </ItemList>
    </Section>
  )
}

const bodies: Record<Tab, () => React.ReactNode> = {
  general: General,
  github: GitHubSettings,
  keys: TeamKeys,
  tokens: Tokens,
  notifications: Notifications,
}

export function Settings() {
  const [tab, setTab] = useState<Tab>('general')
  const Body = bodies[tab]

  return (
    <Page title="Settings">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Body />
    </Page>
  )
}
