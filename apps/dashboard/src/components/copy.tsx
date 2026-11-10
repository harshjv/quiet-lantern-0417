import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
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
  )
}
