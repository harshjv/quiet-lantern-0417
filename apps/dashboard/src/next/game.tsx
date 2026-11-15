import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const badges = [
  {
    name: 'First ship',
    earned: true,
  },
  {
    name: 'First fix',
    earned: true,
  },
  {
    name: '10 tasks',
    earned: false,
  },
  {
    name: 'Green week',
    earned: false,
  },
]

export function YourWeek() {
  return (
    <Card className="flex-row items-center gap-6 px-6 py-4">
      <Stat value="5" label="day streak" />
      <Stat value="7" label="shipped" />
      <Stat value="2" label="fixes" />
      <div className="ml-auto flex flex-wrap justify-end gap-2">
        {badges.map((b) => (
          <span
            key={b.name}
            className={cn(
              'border px-2 py-1 font-display text-xs',
              b.earned ? 'border-primary text-primary' : 'border-dashed text-muted-foreground',
            )}
          >
            {b.name}
          </span>
        ))}
      </div>
    </Card>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-display text-2xl leading-none text-primary tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
