import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Keyboard, ListChecks, LogOut, Monitor, Moon, Package, Sun, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'

import { ShortcutKeys } from '@/components/shortcut-keys'
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
import { inventoryQuery } from '@/lib/queries'
import { toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

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

export function ThemeMenu() {
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

export function UserMenu({ onHelp }: { onHelp: () => void }) {
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
        <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground">
          <UserRound /> Account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-56">
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
            <Link to="/projects" onClick={() => setGuideHidden(false)}>
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
