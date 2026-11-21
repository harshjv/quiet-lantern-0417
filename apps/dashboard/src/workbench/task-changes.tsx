import { Link } from '@tanstack/react-router'
import { FileDiff } from 'lucide-react'
import type { ReactNode } from 'react'

import { EmptyState } from '@/components/page'
import type { Turn } from '@/lib/agent-session'
import { plural, shortAgo } from '@/lib/format'
import { taskTo } from '@/lib/links'

import { parentOf } from './task-files'

export type ChangesItem = Extract<Turn['items'][number], { kind: 'changes' }>

const totals = (items: ChangesItem[]) => {
  const files = items.flatMap((item) => item.files)

  return {
    files: items.reduce((sum, item) => sum + item.files.length + item.moreFiles, 0),
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    commits: items.reduce((sum, item) => sum + item.commits.length, 0),
  }
}

export const changedFileCount = (turns: Turn[]) =>
  new Set(
    turns.flatMap((turn) =>
      turn.items.flatMap((item) => (item.kind === 'changes' ? item.files.map((f) => f.path) : [])),
    ),
  ).size

const changesLine = (item: ChangesItem) => {
  const sum = totals([item])

  return [
    sum.files ? `${plural(sum.files, 'file')} changed, +${sum.added} −${sum.removed}` : null,
    sum.commits ? plural(sum.commits, 'commit') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

export function ChangesView({
  item,
  open,
  file,
}: {
  item: ChangesItem
  open?: boolean
  file?: (path: string) => ReactNode
}) {
  return (
    <details className="border border-border text-sm" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground tabular-nums">
        {changesLine(item)}
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        {item.commits.map((commit) => (
          <p key={commit.sha} className="text-xs">
            <code className="text-muted-foreground">{commit.sha.slice(0, 7)}</code> {commit.subject}
          </p>
        ))}
        {item.files.map((entry) => (
          <details key={entry.path}>
            <summary className="cursor-pointer text-xs">
              <code>{entry.path}</code>{' '}
              <span className="text-muted-foreground tabular-nums">
                {entry.added === null ? 'binary' : `+${entry.added} −${entry.removed}`}
              </span>
              {file && <span className="ml-2">{file(entry.path)}</span>}
            </summary>
            {entry.diff ? (
              <pre className="mt-1 max-h-72 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre">
                {entry.diff}
              </pre>
            ) : null}
          </details>
        ))}
        {item.moreFiles > 0 && (
          <p className="text-xs text-muted-foreground">{plural(item.moreFiles, 'more file')}</p>
        )}
        {item.truncated && <p className="text-xs text-muted-foreground">Diffs cut at 2 KiB</p>}
      </div>
    </details>
  )
}

export function TaskChanges({
  turns,
  project,
  task,
}: {
  turns: Turn[]
  project: string
  task: string
}) {
  const changed = turns.flatMap((turn, index) =>
    turn.items
      .filter((item): item is ChangesItem => item.kind === 'changes')
      .map((item) => ({
        turn,
        number: index + 1,
        item,
      })),
  )

  if (changed.length === 0) {
    return <EmptyState icon={FileDiff} title="No changes yet" />
  }

  const sum = totals(changed.map((entry) => entry.item))

  return (
    <div className="flex flex-col gap-4 pb-6">
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {(
          [
            ['Files', sum.files],
            ['Added', `+${sum.added}`],
            ['Removed', `−${sum.removed}`],
            ['Commits', sum.commits],
            ['Turns', changed.length],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {changed.map(({ turn, number, item }) => (
        <section key={item.id} className="flex flex-col gap-2">
          <header className="flex min-w-0 items-baseline gap-3 text-sm">
            <span className="shrink-0 font-medium tabular-nums">Turn {number}</span>
            {turn.prompt && (
              <span className="min-w-0 truncate text-muted-foreground">
                “{turn.prompt.split('\n')[0]}”
              </span>
            )}
            {turn.startedAt && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {shortAgo(turn.startedAt)}
              </span>
            )}
          </header>
          <ChangesView
            item={item}
            open
            file={(path) => (
              <Link
                {...taskTo(project, task, 'files', {
                  path: parentOf(path),
                  file: path,
                })}
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Open
              </Link>
            )}
          />
        </section>
      ))}
    </div>
  )
}
