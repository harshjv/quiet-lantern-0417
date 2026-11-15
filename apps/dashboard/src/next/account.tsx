import { Bot, GitBranch, KeyRound, Laptop, Mail, Terminal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

import { yourKeys } from './fixtures'
import { devices, emailWhen } from './fixtures-outside'
import { ItemList, ItemRow, Page, Section, StatusPill } from './parts'

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

export function Account() {
  return (
    <Page title="Your account">
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
