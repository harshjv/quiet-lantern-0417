import {
  Hourglass,
  Loader,
  SquareCheck,
  SquareDashed,
  SquareDot,
  SquareSlash,
  SquareX,
  type LucideIcon,
} from 'lucide-react'

import { toneText, type Tone } from '@/lib/tone'
import { cn } from '@/lib/utils'

export type State = 'done' | 'working' | 'pending' | 'waiting' | 'queued' | 'failed' | 'denied'

export const stateLabel: Record<State, string> = {
  done: 'Done',
  working: 'In progress',
  pending: 'Starting',
  waiting: 'Waiting on you',
  queued: 'Queued',
  failed: 'Failed',
  denied: 'Denied',
}

const look: Record<State, { icon: LucideIcon; tone: Tone; motion?: string }> = {
  done: {
    icon: SquareCheck,
    tone: 'success',
  },
  working: {
    icon: Loader,
    tone: 'info',
    motion: 'motion-safe:animate-spin',
  },
  pending: {
    icon: SquareDashed,
    tone: 'info',
    motion: 'motion-safe:animate-pulse',
  },
  waiting: {
    icon: SquareDot,
    tone: 'warning',
    motion: 'motion-safe:animate-pulse',
  },
  queued: {
    icon: Hourglass,
    tone: 'neutral',
  },
  failed: {
    icon: SquareX,
    tone: 'danger',
  },
  denied: {
    icon: SquareSlash,
    tone: 'warning',
  },
}

export function StateIcon({ state, className }: { state: State; className?: string }) {
  const { icon: Icon, tone, motion } = look[state]

  return (
    <Icon
      className={cn('size-4 shrink-0', toneText[tone], motion, className)}
      aria-label={stateLabel[state]}
      role="img"
    />
  )
}
