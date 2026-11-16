import { CircleCheck, CircleX, MessageCircleQuestion, Rocket, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { shortAgo } from '@/lib/format'
import type { Tone } from '@/lib/tone'

import type { Place } from './app'
import { useTaskRows, type Task } from './data'
import { ItemList, ItemRow, Page, Section, type Fact } from './parts'
import { ShipDecision, shipStatusText, useShipRequests, type ShipRequest } from './ship-request'

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

const liveGroups: Partial<
  Record<Task['state'], { group: Group; icon: typeof Rocket; tone: Tone }>
> = {
  waiting: {
    group: 'decide',
    icon: MessageCircleQuestion,
    tone: 'warning',
  },
  failed: {
    group: 'broken',
    icon: CircleX,
    tone: 'danger',
  },
  finished: {
    group: 'done',
    icon: CircleCheck,
    tone: 'success',
  },
}

const liveItems = (rows: Task[]) =>
  rows.flatMap((t): Item[] => {
    const shape = liveGroups[t.state]

    return shape
      ? [
          {
            id: t.id,
            ...shape,
            title: t.title,
            meta: [
              {
                kind: 'status',
                text: t.reason,
              },
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
          },
        ]
      : []
  })

const shipItems = (requests: ShipRequest[]) =>
  requests.map((request): Item => ({
    id: request.id,
    group: 'decide',
    icon: Rocket,
    tone: 'warning',
    title: `Ship ${request.title}`,
    meta: [
      {
        kind: 'status',
        text: request.reason ?? shipStatusText[request.status],
      },
      {
        kind: 'time',
        text: shortAgo(request.created_at),
      },
    ],
    action: (go) => (
      <>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            go({
              mode: 'build',
              view: request.task_id,
            })
          }
        >
          Open
        </Button>
        <ShipDecision request={request} />
      </>
    ),
  }))

export function useInbox(): Item[] {
  const rows = useTaskRows()
  const ships = useShipRequests()

  return [...shipItems(ships), ...liveItems(rows)]
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
        <p className="text-sm text-muted-foreground">
          Nothing is waiting on you. Questions from agents, work waiting to ship and tasks that
          failed show up here.
        </p>
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
