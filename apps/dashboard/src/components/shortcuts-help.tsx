import { ShortcutKeys } from '@/components/shortcut-keys'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { shortcutGroups, shortcuts } from '@/lib/shortcuts'

export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts wait while you type in a field, except the command palette.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {shortcutGroups().map(({ place, ids }) => (
            <section key={place} aria-labelledby={`shortcuts-${place}`}>
              <h3
                id={`shortcuts-${place}`}
                className="mb-1.5 text-xs font-medium text-muted-foreground"
              >
                {place}
              </h3>
              <dl className="divide-y">
                {ids.map((id) => (
                  <div key={id} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <dt>{shortcuts[id].label}</dt>
                    <dd>
                      <ShortcutKeys id={id} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
