import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const slackPx = 48

export function FollowTail({
  changes,
  label,
  className,
  children,
}: {
  changes: unknown
  label: string
  className?: string
  children: ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const [atTail, setAtTail] = useState(true)

  const jump = () => {
    const node = element.current

    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }

  useEffect(() => {
    if (atTail) {
      jump()
    }
  }, [changes, atTail])

  return (
    <div className="relative">
      <div
        ref={element}
        onScroll={() => {
          const node = element.current

          if (node) {
            setAtTail(node.scrollHeight - node.scrollTop - node.clientHeight < slackPx)
          }
        }}
        className={cn('overflow-auto', className)}
        tabIndex={0}
        role="log"
        aria-label={label}
      >
        {children}
      </div>
      {!atTail && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-4 bottom-4 shadow"
          onClick={() => {
            jump()
            setAtTail(true)
          }}
        >
          Jump to latest
        </Button>
      )}
    </div>
  )
}
