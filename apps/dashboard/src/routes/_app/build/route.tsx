import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/build')({
  staticData: {
    mode: 'build',
  },
  head: () => titled('Build'),
})
