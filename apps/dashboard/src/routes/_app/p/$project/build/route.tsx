import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/p/$project/build')({
  staticData: {
    mode: 'build',
  },
  head: ({ params }) => titled('Build', params.project),
})
