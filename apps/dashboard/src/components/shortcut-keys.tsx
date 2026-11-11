import { Fragment } from 'react'

import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { isMac, shortcutKeys, spokenShortcut, type ShortcutId } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

const mac = isMac(navigator.userAgent)

export const spoken = (id: ShortcutId) => spokenShortcut(id, mac)

export function ShortcutKeys({ id, className }: { id: ShortcutId; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}
      aria-label={spoken(id)}
      role="img"
    >
      {shortcutKeys(id, mac).map((keys, step) => (
        <Fragment key={step}>
          {step > 0 && <span>then</span>}
          <KbdGroup>
            {keys.map((key) => (
              <Kbd key={key.name}>{key.text}</Kbd>
            ))}
          </KbdGroup>
        </Fragment>
      ))}
    </span>
  )
}
