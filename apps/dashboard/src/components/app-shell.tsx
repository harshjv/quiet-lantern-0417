import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Keyboard,
  ListChecks,
  LogOut,
  Monitor,
  Moon,
  Package,
  Search,
  Sun,
  UserRound,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { useState, type ReactNode } from 'react'

import { CommandPalette } from '@/components/command-palette'
import { Logo } from '@/components/logo'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { ShortcutsHelp } from '@/components/shortcuts-help'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { authClient, sessionQuery } from '@/lib/auth'
import type { StreamState } from '@/lib/event-stream'
import { setGuideHidden, useGuideHidden } from '@/lib/first-run'
import { useLiveEvents } from '@/lib/live'
import { inventoryQuery, stagedQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { countPill, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

const liveText: Record<StreamState, string> = {
  live: 'Updates on',
  connecting: 'Reconnecting',
  offline: 'Updates paused',
}

function LiveIndicator({ state }: { state: StreamState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
          role="status"
          aria-label={liveText[state]}
          tabIndex={0}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              toneDot[state === 'live' ? 'success' : state === 'connecting' ? 'warning' : 'danger'],
            )}
            aria-hidden
          />
          {liveText[state]}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Status changes appear without refreshing. Reconnects on its own.
      </TooltipContent>
    </Tooltip>
  )
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu({ onHelp }: { onHelp: () => void }) {
  const session = useQuery(sessionQuery)
  const inventory = useQuery(inventoryQuery)
  const version = inventory.data?.release?.version
  const guideHidden = useGuideHidden()
  const client = useQueryClient()
  const navigate = useNavigate()
  const signOut = async () => {
    await authClient.signOut()
    client.clear()
    await navigate({
      to: '/login',
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Account menu">
          <UserRound />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs text-muted-foreground">Signed in as</span>
          <span className="block truncate text-sm">{session.data?.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserRound /> Account and sign-in
          </Link>
        </DropdownMenuItem>
        {guideHidden && (
          <DropdownMenuItem asChild>
            <Link to="/" onClick={() => setGuideHidden(false)}>
              <ListChecks /> Get started
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onHelp}>
          <Keyboard /> Keyboard shortcuts
          <DropdownMenuShortcut>
            <ShortcutKeys id="help" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/stations">
            <Package /> {version ? `Stationly v${version}` : 'Stationly version'}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const navLink =
  'rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground data-[status=active]:font-medium'

export function AppShell({ children }: { children: ReactNode }) {
  const live = useLiveEvents()
  const staged = useQuery(stagedQuery('staged'))
  const pending = staged.data?.items.length ?? 0
  const navigate = useNavigate()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)

  useShortcut('palette', () => setPalette((open) => !open))
  useShortcut('help', () => setHelp(true))
  useShortcut(
    'projects',
    () =>
      void navigate({
        to: '/',
      }),
  )
  useShortcut(
    'staged',
    () =>
      void navigate({
        to: '/staged',
      }),
  )
  useShortcut(
    'agents',
    () =>
      void navigate({
        to: '/agents',
      }),
  )

  return (
    <div className="min-h-svh bg-background">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight"
            aria-label="Stationly home"
          >
            <Logo className="size-5" />
            <span className="hidden sm:inline">Stationly</span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            <Link
              to="/"
              activeOptions={{
                exact: true,
              }}
              className={navLink}
            >
              Projects
            </Link>
            <Link to="/staged" className={navLink}>
              Staged changes
              {pending > 0 && (
                <span className={cn('ml-1.5', countPill)} aria-label={`${pending} waiting`}>
                  {pending}
                </span>
              )}
            </Link>
            <Link to="/agents" className={navLink}>
              Agents
            </Link>
            <Link to="/stations" className={navLink}>
              Stations
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setPalette(true)}
              aria-haspopup="dialog"
            >
              <Search aria-hidden />
              <span className="hidden md:inline">Search or run a command</span>
              <span className="sr-only md:hidden">Search or run a command</span>
              <ShortcutKeys id="palette" className="hidden md:inline-flex" />
            </Button>
            <LiveIndicator state={live} />
            <ThemeMenu />
            <UserMenu onHelp={() => setHelp(true)} />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6" tabIndex={-1}>
        {children}
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={() => setHelp(true)} />
      <ShortcutsHelp open={help} onOpenChange={setHelp} />
    </div>
  )
}
