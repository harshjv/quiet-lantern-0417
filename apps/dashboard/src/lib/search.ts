import { useNavigate, useSearch, type RegisteredRouter } from '@tanstack/react-router'
import { z } from 'zod'

import { useShortcut } from './shortcuts'

type SearchTab = NonNullable<
  ReturnType<typeof useSearch<RegisteredRouter, undefined, false>>['tab']
>

export const tabSearch = <const T extends readonly [string, ...string[]]>(tabs: T) =>
  z.object({
    tab: z.enum(tabs).default(tabs[0]).catch(tabs[0]),
  })

export function useSearchTab(tabs: readonly SearchTab[]) {
  const navigate = useNavigate()
  const select = (value: string | undefined) => {
    const tab = tabs.find((candidate) => candidate === value)

    if (tab) {
      void navigate({
        to: '.',
        search: {
          tab,
        },
        replace: true,
      })
    }
  }

  useShortcut('tab', (index) => select(tabs[index]))

  return select
}
