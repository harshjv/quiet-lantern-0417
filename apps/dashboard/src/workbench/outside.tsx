import { useQuery } from '@tanstack/react-query'
import { Bell, KeyRound, Plug, Server, Users, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { Rows } from '@/components/page'
import { PlaceLink } from '@/components/place-link'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { isInstanceAdmin } from '@/lib/agent-session'
import { places, viewId, type Go, type Place } from '@/lib/nav'
import { meQuery } from '@/lib/queries'
import { toneText } from '@/lib/tone'

import { Account } from './account'
import { ApprovalPage } from './approval-live'
import { LiveConnect } from './connect-live'
import { Inbox, useInboxCount } from './inbox'
import { Notice, Page as PageFrame } from './parts'
import { LiveServers } from './servers-live'
import { LiveTeam } from './team-live'

export type Page = 'inbox' | 'account' | 'team' | 'servers' | 'connect'

export const pages: {
  id: Page
  title: string
  icon: LucideIcon
  group: 'you' | 'team'
  admin?: boolean
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
    body: LiveTeam,
  },
  {
    id: 'servers',
    title: 'Servers',
    icon: Server,
    group: 'team',
    admin: true,
    body: LiveServers,
  },
  {
    id: 'connect',
    title: 'Connect',
    icon: Plug,
    group: 'team',
    body: LiveConnect,
  },
]

export const pageOf = (view: string | null) => pages.find((p) => p.id === view) ?? pages[0]!

export function useVisiblePages() {
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])

  return {
    loaded: me.isSuccess,
    pages: pages.filter((p) => admin || !p.admin),
  }
}

export function OutsideScreen({ place, go }: { place: Place; go: Go }) {
  const visible = useVisiblePages()
  const approval = viewId(place.view, 'approval')

  if (approval) {
    return <ApprovalPage approvalId={approval} />
  }

  const page = pageOf(place.view)

  if (page.admin && !visible.loaded) {
    return (
      <PageFrame title={page.title}>
        <Rows count={4} />
      </PageFrame>
    )
  }

  if (!visible.pages.includes(page)) {
    return (
      <PageFrame title={page.title}>
        <Notice tone="info" title={`Only an admin sees ${page.title.toLowerCase()}`}>
          Ask an admin of this team if you need something here.
        </Notice>
      </PageFrame>
    )
  }

  const Body = page.body

  return <Body go={go} />
}

export function OutsideNav({ place }: { place: Place; go: Go }) {
  const count = useInboxCount()
  const { pages: shown } = useVisiblePages()
  const current = viewId(place.view, 'approval') ? 'inbox' : pageOf(place.view).id

  return (['you', 'team'] as const).map((group) => (
    <SidebarGroup key={group}>
      <SidebarGroupLabel>{group === 'you' ? 'You' : 'Team'}</SidebarGroupLabel>
      <SidebarMenu>
        {shown
          .filter((p) => p.group === group)
          .map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={current === p.id}>
                <PlaceLink to={places.page(p.id)}>
                  <p.icon /> {p.title}
                </PlaceLink>
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
