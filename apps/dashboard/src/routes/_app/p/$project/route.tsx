import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/p/$project')({
  staticData: {
    mode: 'overview',
  },
  head: ({ params }) => titled(params.project),
})
