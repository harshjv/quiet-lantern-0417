import { useHotkeys } from 'react-hotkeys-hook'

export const places = ['Anywhere', 'Pages with tabs', 'Lists', 'App', 'Logs and sessions'] as const

export type Place = (typeof places)[number]

export type Shortcut = {
  keys: readonly string[]
  label: string
  place: Place
  inFields?: boolean
}

const tabKeys = Array.from(
  {
    length: 6,
  },
  (_, index) => `g>${index + 1}`,
)

export const shortcuts = {
  palette: {
    keys: ['mod+k'],
    label: 'Search or run a command',
    place: 'Anywhere',
    inFields: true,
  },
  help: {
    keys: ['shift+slash'],
    label: 'Show keyboard shortcuts',
    place: 'Anywhere',
  },
  newTask: {
    keys: ['n'],
    label: 'Start a new task',
    place: 'Anywhere',
  },
  build: {
    keys: ['g>b'],
    label: 'Go to Build',
    place: 'Anywhere',
  },
  ship: {
    keys: ['g>s'],
    label: 'Go to Ship',
    place: 'Anywhere',
  },
  observe: {
    keys: ['g>o'],
    label: 'Go to Observe',
    place: 'Anywhere',
  },
  inbox: {
    keys: ['g>i'],
    label: 'Go to the Inbox',
    place: 'Anywhere',
  },
  connect: {
    keys: ['g>c'],
    label: 'Go to connect an agent',
    place: 'Anywhere',
  },
  account: {
    keys: ['g>a'],
    label: 'Go to your account',
    place: 'Anywhere',
  },
  team: {
    keys: ['g>t'],
    label: 'Go to the team',
    place: 'Anywhere',
  },
  servers: {
    keys: ['g>v'],
    label: 'Go to servers',
    place: 'Anywhere',
  },
  sidebar: {
    keys: ['mod+b'],
    label: 'Show or hide the sidebar',
    place: 'Anywhere',
  },
  tab: {
    keys: tabKeys,
    label: 'Switch to a tab by its position',
    place: 'Pages with tabs',
  },
  create: {
    keys: ['c'],
    label: 'Create a project or app',
    place: 'Lists',
  },
  deploy: {
    keys: ['d'],
    label: 'Deploy this app',
    place: 'App',
  },
  filter: {
    keys: ['slash'],
    label: 'Filter log lines or sessions',
    place: 'Logs and sessions',
  },
} as const satisfies Record<string, Shortcut>

export type ShortcutId = keyof typeof shortcuts

export const isMac = (userAgent: string) =>
  /mac/i.test(userAgent) && !/iphone|ipad|ipod/i.test(userAgent)

export type Key = { text: string; name: string }

const named = (mac: boolean): Record<string, Key> => ({
  mod: mac
    ? {
        text: '⌘',
        name: 'Command',
      }
    : {
        text: 'Ctrl',
        name: 'Control',
      },
  shift: {
    text: mac ? '⇧' : 'Shift',
    name: 'Shift',
  },
  slash: {
    text: '/',
    name: 'Slash',
  },
  'shift+slash': {
    text: '?',
    name: 'Question mark',
  },
})

const key = (value: string, mac: boolean): Key =>
  named(mac)[value] ?? {
    text: value.toUpperCase(),
    name: value.toUpperCase(),
  }

export const keySteps = (hotkey: string, mac: boolean) =>
  hotkey
    .split('>')
    .map((step) => (step in named(mac) ? [step] : step.split('+')).map((value) => key(value, mac)))

export const shortcutKeys = (id: ShortcutId, mac: boolean) => {
  const keys: readonly string[] = shortcuts[id].keys
  const last = keySteps(keys.at(-1)!, mac)

  return keySteps(keys[0]!, mac).map((step, index) =>
    step.map((first, position): Key => {
      const end = last[index]![position]!

      return end.text === first.text
        ? first
        : {
            text: `${first.text}–${end.text}`,
            name: `${first.name} to ${end.name}`,
          }
    }),
  )
}

export const spokenShortcut = (id: ShortcutId, mac: boolean) =>
  shortcutKeys(id, mac)
    .map((keys) => keys.map((key) => key.name).join(' '))
    .join(' then ')

export const shortcutGroups = () =>
  places.map((place) => ({
    place,
    ids: (Object.keys(shortcuts) as ShortcutId[]).filter((id) => shortcuts[id].place === place),
  }))

export function useShortcut(id: ShortcutId, run: (index: number) => void, enabled = true) {
  const shortcut: Shortcut = shortcuts[id]

  useHotkeys(shortcut.keys, (_event, hotkey) => run(shortcut.keys.indexOf(hotkey.hotkey)), {
    enabled,
    preventDefault: true,
    enableOnFormTags: shortcut.inFields ?? false,
    description: shortcut.label,
  })
}
