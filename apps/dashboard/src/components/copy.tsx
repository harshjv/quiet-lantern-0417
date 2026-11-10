import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function CopyButton({
  value,
  label,
  hint,
  className,
}: {
  value: string
  label: string
  hint?: string
  className?: string
}) {
  const [done, setDone] = useState(false)
  const [hover, setHover] = useState(false)
  return (
    <Tooltip open={done || hover} onOpenChange={setHover}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn('text-muted-foreground hover:text-foreground', className)}
          aria-label={done ? `${label} copied` : `Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setDone(true)
              window.setTimeout(() => setDone(false), 1500)
            })
          }}
        >
          {done ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {done ? (hint ? `Copied. ${hint}` : 'Copied') : `Copy ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}
