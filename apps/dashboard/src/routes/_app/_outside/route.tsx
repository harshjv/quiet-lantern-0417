import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/_outside')({
  staticData: {
    mode: 'outside',
  },
})
