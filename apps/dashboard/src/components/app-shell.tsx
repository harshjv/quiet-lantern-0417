import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'
import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { authClient, sessionQuery } from '@/lib/auth'
import { useLiveEvents, type LiveState } from '@/lib/live'
import { stagedQuery } from '@/lib/queries'
import { countPill, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

const liveText: Record<LiveState, string> = { live: 'Live', connecting: 'Connecting', offline: 'Offline' }

function LiveIndicator({ state }: { state: LiveState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground" role="status" aria-label={`Event stream ${liveText[state].toLowerCase()}`} tabIndex={0}>
          <span className={cn('size-1.5 rounded-full', toneDot[state === 'live' ? 'success' : state === 'connecting' ? 'warning' : 'danger'])} aria-hidden />
          {liveText[state]}
        </span>
      </TooltipTrigger>
      <TooltipContent>Status updates arrive over the events stream</TooltipContent>
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

function UserMenu() {
  const session = useQuery(sessionQuery)
  const client = useQueryClient()
  const navigate = useNavigate()
  const signOut = async () => {
    await authClient.signOut()
    client.clear()
    await navigate({ to: '/login' })
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
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const navLink = 'rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground data-[status=active]:font-medium'

export function AppShell({ children }: { children: ReactNode }) {
  const live = useLiveEvents()
  const staged = useQuery(stagedQuery('staged'))
  const pending = staged.data?.items.length ?? 0
  return (
    <div className="min-h-svh bg-background">
      <a href="#main" className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight" aria-label="Stationly home">
            <Logo className="size-5" />
            <span className="hidden sm:inline">Stationly</span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            <Link to="/" activeOptions={{ exact: true }} className={navLink}>
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
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <LiveIndicator state={live} />
            <ThemeMenu />
            <UserMenu />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
