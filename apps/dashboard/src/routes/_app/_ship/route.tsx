import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/_ship')({
  staticData: {
    mode: 'ship',
  },
  head: () => titled('Ship'),
})
