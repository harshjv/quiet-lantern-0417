import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Keyboard, ListChecks, LogOut, Monitor, Moon, Package, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { ShortcutKeys } from '@/components/shortcut-keys'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isInstanceAdmin } from '@/lib/agent-session'
import { sessionQuery, signOut } from '@/lib/auth'
import type { StreamState } from '@/lib/event-stream'
import { setGuideHidden } from '@/lib/first-run'
import { inventoryQuery, meQuery } from '@/lib/queries'
import { toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'
import { useVisiblePages } from '@/workbench/outside'

const liveText: Record<StreamState, string> = {
  live: 'Updates on',
  connecting: 'Reconnecting',
  offline: 'Updates paused',
}

export function LiveIndicator({ state }: { state: StreamState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground"
          role="status"
          aria-label={liveText[state]}
          tabIndex={0}
        >
          <span
            className={cn(
              'size-1.5',
              toneDot[state === 'live' ? 'success' : state === 'connecting' ? 'warning' : 'danger'],
            )}
            aria-hidden
          />
          {state === 'live' ? null : liveText[state]}
        </span>
      </TooltipTrigger>
      <TooltipContent>{liveText[state]}</TooltipContent>
    </Tooltip>
  )
}

const themes = [
  {
    value: 'light',
    label: 'Light',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: Moon,
  },
  {
    value: 'system',
    label: 'System',
    icon: Monitor,
  },
]

function ThemeChoice() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sun className="dark:hidden" />
        <Moon className="hidden dark:block" /> Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          {themes.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value}>
              <t.icon /> {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const initialsOf = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?'

function useAccount() {
  const session = useQuery(sessionQuery)
  const inventory = useQuery(inventoryQuery)
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const user = session.data?.user

  return {
    name: user?.name || user?.email || 'Signed in',
    detail: user?.email ?? '',
    role: admin ? 'Admin' : 'Member',
    admin,
    version: inventory.data?.release?.version ?? null,
  }
}

export function AccountMenu({ onHelp }: { onHelp: () => void }) {
  const account = useAccount()
  const client = useQueryClient()
  const { pages } = useVisiblePages()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-7">
            <AvatarFallback>{initialsOf(account.name)}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{account.name}</span>
            <span className="text-xs text-muted-foreground">{account.role}</span>
          </span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate">{account.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {account.detail}
          </span>
        </DropdownMenuLabel>
        {pages
          .filter((p) => p.id !== 'inbox')
          .map((p) => (
            <DropdownMenuItem key={p.id} asChild>
              <Link to={p.to}>
                <p.icon /> {p.title}
              </Link>
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <ThemeChoice />
        <DropdownMenuItem asChild>
          <Link to="/" onClick={() => setGuideHidden(false)}>
            <ListChecks /> Get started
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onHelp}>
          <Keyboard /> Keyboard shortcuts
          <DropdownMenuShortcut>
            <ShortcutKeys id="help" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {account.version &&
          (account.admin ? (
            <DropdownMenuItem asChild>
              <Link to="/servers">
                <Package /> Stationly {account.version}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <Package /> Stationly {account.version}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut(client)}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
