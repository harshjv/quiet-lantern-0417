import { useQuery } from '@tanstack/react-query'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Bell, KeyRound, Plug, Server, Users, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { Rows } from '@/components/page'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { isInstanceAdmin } from '@/lib/agent-session'
import { meQuery } from '@/lib/queries'
import { titled } from '@/lib/title'
import { toneText } from '@/lib/tone'

import { Account } from './account'
import { LiveConnect } from './connect-live'
import { Inbox, useInboxCount } from './inbox'
import { Notice, Page as PageFrame } from './parts'
import { LiveServers } from './servers-live'
import { LiveTeam } from './team-live'

export type Page = 'inbox' | 'account' | 'team' | 'servers' | 'connect'

export const pages: {
  id: Page
  to: `/${Page}`
  title: string
  icon: LucideIcon
  group: 'you' | 'team'
  admin?: boolean
  body: ComponentType
}[] = [
  {
    id: 'inbox',
    to: '/inbox',
    title: 'Inbox',
    icon: Bell,
    group: 'you',
    body: Inbox,
  },
  {
    id: 'account',
    to: '/account',
    title: 'Your account',
    icon: KeyRound,
    group: 'you',
    body: Account,
  },
  {
    id: 'team',
    to: '/team',
    title: 'Team',
    icon: Users,
    group: 'team',
    body: LiveTeam,
  },
  {
    id: 'servers',
    to: '/servers',
    title: 'Servers',
    icon: Server,
    group: 'team',
    admin: true,
    body: LiveServers,
  },
  {
    id: 'connect',
    to: '/connect',
    title: 'Connect',
    icon: Plug,
    group: 'team',
    body: LiveConnect,
  },
]

export const pageOf = (id: Page) => pages.find((p) => p.id === id)!

export const pageHead = (id: Page) => titled(pageOf(id).title)

export function useVisiblePages() {
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])

  return {
    loaded: me.isSuccess,
    pages: pages.filter((p) => admin || !p.admin),
  }
}

export function OutsideScreen({ page: id }: { page: Page }) {
  const visible = useVisiblePages()
  const page = pageOf(id)

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

  return <Body />
}

export function OutsideNav() {
  const count = useInboxCount()
  const { pages: shown } = useVisiblePages()
  const matchRoute = useMatchRoute()
  const active = (page: (typeof pages)[number]) =>
    Boolean(
      matchRoute({
        to: page.to,
      }) ||
      (page.id === 'inbox' &&
        matchRoute({
          to: '/approvals/$approval',
        })),
    )

  return (['you', 'team'] as const).map((group) => (
    <SidebarGroup key={group}>
      <SidebarGroupLabel>{group === 'you' ? 'You' : 'Team'}</SidebarGroupLabel>
      <SidebarMenu>
        {shown
          .filter((p) => p.group === group)
          .map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={active(p)}>
                <Link to={p.to}>
                  <p.icon /> {p.title}
                </Link>
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
