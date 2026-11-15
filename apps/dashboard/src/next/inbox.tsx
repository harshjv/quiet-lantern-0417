import { CircleCheck, CircleX, KeyRound, MessageCircleQuestion, Rocket, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Tone } from '@/lib/tone'

import type { Place } from './app'
import { ItemList, ItemRow, Page, Section, type Fact } from './parts'
import { PixelScene } from './scene'
import { useWorld } from './story'

type Go = (next: Partial<Place>) => void

type Group = 'decide' | 'broken' | 'done'

type Item = {
  id: string
  group: Group
  icon: typeof Rocket
  tone: Tone
  title: string
  meta: Fact[]
  action: (go: Go) => ReactNode
}

const groups: { id: Group; title: string; tab: string }[] = [
  {
    id: 'decide',
    title: 'Needs your decision',
    tab: 'Decide',
  },
  {
    id: 'broken',
    title: 'Something broke',
    tab: 'Broken',
  },
  {
    id: 'done',
    title: 'Finished',
    tab: 'Done',
  },
]

export function useInbox(): Item[] {
  const { tasks, approvals, incidents } = useWorld()
  const mine = tasks.filter((t) => t.owner === 'you')

  return [
    ...approvals.map((a): Item => ({
      id: a.title,
      group: 'decide',
      icon: a.kind === 'key' ? KeyRound : Rocket,
      tone: 'warning',
      title: a.title,
      meta: [
        {
          kind: 'project',
          text: a.project,
        },
        {
          kind: 'user',
          text: `asked by ${a.by}`,
        },
        {
          kind: 'time',
          text: a.age,
        },
        ...a.facts,
      ],
      action: (go) => (
        <Button
          size="sm"
          onClick={() =>
            go({
              mode: 'ship',
              project: a.project,
              view: a.story ? 'review' : null,
            })
          }
        >
          Review
        </Button>
      ),
    })),
    ...mine
      .filter((t) => t.state === 'waiting')
      .map((t): Item => ({
        id: t.id,
        group: 'decide',
        icon: MessageCircleQuestion,
        tone: 'warning',
        title: `${t.reason} in ${t.title}`,
        meta: [
          {
            kind: 'project',
            text: t.project,
          },
          {
            kind: 'time',
            text: t.age,
          },
        ],
        action: (go) => (
          <Button
            size="sm"
            onClick={() =>
              go({
                mode: 'build',
                view: t.id,
              })
            }
          >
            Open
          </Button>
        ),
      })),
    ...incidents
      .filter((i) => i.tone === 'danger')
      .map((i): Item => ({
        id: i.title,
        group: 'broken',
        icon: CircleX,
        tone: 'danger',
        title: i.title,
        meta: [
          {
            kind: 'project',
            text: i.project,
          },
          ...i.facts,
          {
            kind: 'time',
            text: i.age,
          },
        ],
        action: (go) => (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                go({
                  mode: 'ship',
                  project: i.project,
                  view: 'deploy',
                })
              }
            >
              Open deploy
            </Button>
            <Button
              size="sm"
              onClick={() =>
                go({
                  mode: 'build',
                  project: i.project,
                  view: 'fix',
                })
              }
            >
              Fix with an agent
            </Button>
          </>
        ),
      })),
    ...mine
      .filter((t) => t.state === 'finished')
      .map((t): Item => ({
        id: t.id,
        group: 'done',
        icon: CircleCheck,
        tone: 'success',
        title: `${t.title} is done`,
        meta: [
          {
            kind: 'project',
            text: t.project,
          },
          {
            kind: 'time',
            text: t.age,
          },
        ],
        action: (go) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              go({
                mode: 'build',
                view: t.id,
              })
            }
          >
            Open
          </Button>
        ),
      })),
  ]
}

export const useInboxCount = () => useInbox().filter((i) => i.group !== 'done').length

export function Inbox({ go }: { go: Go }) {
  const items = useInbox()
  const [filter, setFilter] = useState<Group | 'all'>('all')
  const [cleared, setCleared] = useState<string[]>([])
  const open = items.filter((i) => !cleared.includes(i.id))
  const shown = groups.filter((g) => filter === 'all' || g.id === filter)

  return (
    <Page title="Inbox">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Group | 'all')}>
        <TabsList>
          <TabsTrigger value="all">All {open.length}</TabsTrigger>
          {groups.map((g) => (
            <TabsTrigger key={g.id} value={g.id}>
              {g.tab} {open.filter((i) => i.group === g.id).length}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {open.length === 0 ? (
        <div className="flex flex-col gap-3">
          <PixelScene slots={1} running={0} queued={0} live className="h-40 border" />
          <p className="text-sm text-muted-foreground">
            Nothing is waiting on you. Questions from agents, changes to approve and failed deploys
            show up here, and by email as you chose in Your account.
          </p>
        </div>
      ) : (
        shown.map((g) => {
          const rows = open.filter((i) => i.group === g.id)

          return (
            rows.length > 0 && (
              <Section key={g.id} title={g.title} count={rows.length}>
                <ItemList>
                  {rows.map((i) => (
                    <ItemRow
                      key={i.id}
                      icon={i.icon}
                      tone={i.tone}
                      title={i.title}
                      meta={i.meta}
                      action={
                        <>
                          {i.action(go)}
                          {i.group === 'done' && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Clear ${i.title}`}
                              onClick={() => setCleared([...cleared, i.id])}
                            >
                              <X />
                            </Button>
                          )}
                        </>
                      }
                    />
                  ))}
                </ItemList>
              </Section>
            )
          )
        })
      )}
    </Page>
  )
}
