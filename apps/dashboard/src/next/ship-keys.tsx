import { CircleAlert, KeyRound, Link2, Lock, MoreHorizontal, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { keysOf, type KeyRow } from './fixtures'
import { Chips, Notice, Person, Section } from './parts'

function Value({ state, text }: { state: 'set' | 'missing' | 'linked' | 'none'; text?: string }) {
  if (state === 'none') {
    return <span className="text-muted-foreground">None</span>
  }

  if (state === 'missing') {
    return (
      <span className={cn('inline-flex items-center gap-1.5', toneText.warning)}>
        <CircleAlert className="size-3.5" /> No value
      </span>
    )
  }

  if (state === 'linked') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Link2 className={cn('size-3.5', toneText.success)} /> {text ?? 'Linked'}
      </span>
    )
  }

  return text ? (
    <span className="font-mono text-xs">{text}</span>
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <Lock className={cn('size-3.5', toneText.success)} /> Set
    </span>
  )
}

const previewCell = (k: KeyRow) =>
  k.previews === 'own' ? (
    <Value state="set" text={k.previewValue} />
  ) : k.previews === 'same' ? (
    <Value state="linked" text="Same as production" />
  ) : k.previews === 'linked' ? (
    <Value state="linked" text="Each preview's own" />
  ) : (
    <Value state={k.previews} />
  )

export function Keys({ project }: { project: string }) {
  const keys = keysOf[project] ?? []
  const missing = keys.find((k) => k.previews === 'missing' && k.usedBy.length > 0)

  return (
    <div className="flex flex-col gap-6">
      {missing && (
        <Notice
          tone="warning"
          title={`${missing.key} has no preview value`}
          action={<Button size="sm">Add a preview value</Button>}
        >
          Previews of {missing.usedBy.join(' and ')} fail to deploy until it has one.
        </Notice>
      )}
      <Section
        icon={KeyRound}
        title="Keys"
        count={keys.length}
        action={
          <Button size="sm">
            <Plus /> Add key
          </Button>
        }
      >
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Production</TableHead>
                <TableHead>Previews</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Last set by</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.key}>
                  <TableCell>
                    <div className="font-mono text-xs font-medium">{k.key}</div>
                    <div className="text-xs text-muted-foreground">
                      {k.secret ? 'Secret' : 'Plain'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Value state={k.production} text={k.productionValue} />
                  </TableCell>
                  <TableCell>{previewCell(k)}</TableCell>
                  <TableCell>
                    {k.usedBy.length ? (
                      <Chips items={k.usedBy} />
                    ) : (
                      <span className="text-xs text-muted-foreground">No app yet</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Person name={k.setBy} sub={k.age} />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" aria-label={`Actions for ${k.key}`}>
                      <MoreHorizontal />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>
      <p className="text-sm text-muted-foreground">
        Your own Claude and GitHub keys are in Your account. Stationly&apos;s own settings, like how
        apps reach it, are not keys you manage, so they are not listed.
      </p>
    </div>
  )
}
