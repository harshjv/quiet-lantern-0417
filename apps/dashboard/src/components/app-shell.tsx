import { Link, useMatches, useNavigate } from '@tanstack/react-router'
import { Menu, PanelLeftOpen } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { Logo } from '@/components/logo'
import { ShortcutsHelp } from '@/components/shortcuts-help'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useLiveEvents } from '@/lib/live'
import { useShortcut } from '@/lib/shortcuts'
import { setSidebarCollapsed, useSidebarCollapsed } from '@/lib/sidebar'
import { cn } from '@/lib/utils'

export function AppShell({ children }: { children: ReactNode }) {
  const live = useLiveEvents()
  const navigate = useNavigate()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const collapsed = useSidebarCollapsed()
  const fullBleed = useMatches({
    select: (matches) => matches.some((match) => match.staticData.fullBleed),
  })

  useShortcut('sidebar', () => setSidebarCollapsed(!collapsed))
  useShortcut('palette', () => setPalette((open) => !open))
  useShortcut('help', () => setHelp(true))
  useShortcut(
    'projects',
    () =>
      void navigate({
        to: '/projects',
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
    'sessions',
    () =>
      void navigate({
        to: '/sessions',
      }),
  )
  useShortcut(
    'connect',
    () =>
      void navigate({
        to: '/connect',
      }),
  )

  return (
    <div className="flex h-svh flex-col bg-background md:flex-row">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open the menu"
          onClick={() => setDrawer(true)}
        >
          <Menu />
        </Button>
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Logo className="size-5" />
          Stationly
        </Link>
      </header>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" showCloseButton={false} className="gap-0 p-0 sm:max-w-80">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">Sessions and places in Stationly</SheetDescription>
          <AppSidebar
            live={live}
            onPalette={() => {
              setDrawer(false)
              setPalette(true)
            }}
            onHelp={() => setHelp(true)}
            onOpen={() => setDrawer(false)}
            collapsible={false}
          />
        </SheetContent>
      </Sheet>
      {!collapsed && (
        <aside aria-label="Sidebar" className="hidden w-72 shrink-0 border-r md:block">
          <AppSidebar
            live={live}
            onPalette={() => setPalette(true)}
            onHelp={() => setHelp(true)}
            collapsible
          />
        </aside>
      )}
      <main id="main" className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" tabIndex={-1}>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="fixed top-2 left-2 z-30 hidden md:inline-flex"
            aria-label="Show the sidebar"
            onClick={() => setSidebarCollapsed(false)}
          >
            <PanelLeftOpen />
          </Button>
        )}
        <div className={cn(fullBleed ? 'flex h-full flex-col' : 'mx-auto max-w-7xl px-4 py-6')}>
          {children}
        </div>
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={() => setHelp(true)} />
      <ShortcutsHelp open={help} onOpenChange={setHelp} />
    </div>
  )
}
