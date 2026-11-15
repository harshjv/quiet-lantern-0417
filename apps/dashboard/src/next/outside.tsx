import {
  Bell,
  Bot,
  KeyRound,
  Server,
  Settings as SettingsIcon,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { toneText } from '@/lib/tone'

import { Account } from './account'
import type { Place } from './app'
import { Assistants } from './assistants'
import { Inbox, useInboxCount } from './inbox'
import { Servers } from './servers'
import { Settings } from './settings'
import { Team } from './team'

type Go = (next: Partial<Place>) => void

export type Page = 'inbox' | 'account' | 'team' | 'assistants' | 'servers' | 'settings'

export const pages: {
  id: Page
  title: string
  icon: LucideIcon
  group: 'you' | 'team'
  body: ComponentType<{ go: Go }>
}[] = [
  {
    id: 'inbox',
    title: 'Inbox',
    icon: Bell,
    group: 'you',
    body: Inbox,
  },
  {
    id: 'account',
    title: 'Your account',
    icon: KeyRound,
    group: 'you',
    body: Account,
  },
  {
    id: 'team',
    title: 'Team',
    icon: Users,
    group: 'team',
    body: Team,
  },
  {
    id: 'assistants',
    title: 'Assistants',
    icon: Bot,
    group: 'team',
    body: Assistants,
  },
  {
    id: 'servers',
    title: 'Servers',
    icon: Server,
    group: 'team',
    body: Servers,
  },
  {
    id: 'settings',
    title: 'Settings',
    icon: SettingsIcon,
    group: 'team',
    body: Settings,
  },
]

const pageOf = (view: string | null) => pages.find((p) => p.id === view) ?? pages[0]!

export function OutsideScreen({ place, go }: { place: Place; go: Go }) {
  const Body = pageOf(place.view).body

  return <Body go={go} />
}

export function OutsideNav({ place, go }: { place: Place; go: Go }) {
  const count = useInboxCount()
  const current = pageOf(place.view).id

  return (['you', 'team'] as const).map((group) => (
    <SidebarGroup key={group}>
      <SidebarGroupLabel>{group === 'you' ? 'You' : 'Team'}</SidebarGroupLabel>
      <SidebarMenu>
        {pages
          .filter((p) => p.group === group)
          .map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton
                isActive={current === p.id}
                onClick={() =>
                  go({
                    view: p.id,
                  })
                }
              >
                <p.icon /> {p.title}
              </SidebarMenuButton>
              {p.id === 'inbox' && count > 0 && (
                <SidebarMenuBadge className={`font-mono ${toneText.warning}`}>
                  {count}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          ))}
      </SidebarMenu>
    </SidebarGroup>
  ))
}
