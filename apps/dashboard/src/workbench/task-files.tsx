import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { File, FileSymlink, Folder, FolderOpen, Loader2 } from 'lucide-react'

import { taskFileLimits } from '@stationly/protocol'

import { Rows } from '@/components/page'
import { Failure } from '@/components/panel'
import { TableFrame } from '@/components/table-frame'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, isStarting, unwrap } from '@/lib/api'
import { blank, bytes, shortAgo } from '@/lib/format'
import { taskTo, type TaskFilePlace } from '@/lib/links'
import { cn } from '@/lib/utils'

export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')

const joined = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

const kindIcon = {
  directory: Folder,
  file: File,
  symlink: FileSymlink,
  other: File,
} as const

const startingRetries = 60

const whileStarting = {
  retry: (count: number, error: unknown) => isStarting(error) && count < startingRetries,
  retryDelay: 2000,
}

function Starting() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      Starting
    </p>
  )
}

const filesOf = (task: string) =>
  api.v1.tasks({
    task,
  }).files

function Crumbs({ project, task, place }: { project: string; task: string; place: TaskFilePlace }) {
  const parts = place.path ? place.path.split('/') : []

  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <Link
        {...taskTo(project, task, 'files')}
        className="font-medium underline-offset-4 hover:underline"
      >
        <FolderOpen className="mr-1 inline size-3.5 text-muted-foreground" aria-hidden />
        Files
      </Link>
      {parts.map((part, index) => (
        <span key={index} className="flex items-center gap-1">
          <span className="text-muted-foreground" aria-hidden>
            /
          </span>
          <Link
            {...taskTo(project, task, 'files', {
              path: parts.slice(0, index + 1).join('/'),
              file: null,
            })}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {part}
          </Link>
        </span>
      ))}
    </nav>
  )
}

function Directory({
  project,
  task,
  place,
}: {
  project: string
  task: string
  place: TaskFilePlace
}) {
  const listing = useQuery({
    queryKey: ['tasks', task, 'files', place.path],
    queryFn: () =>
      unwrap(
        filesOf(task).get({
          query: {
            path: place.path || undefined,
          },
        }),
      ),
    ...whileStarting,
  })

  if (listing.error) {
    return (
      <Failure
        error={listing.error}
        title="Couldn’t list this folder"
        onRetry={() => void listing.refetch()}
      />
    )
  }

  if (!listing.data) {
    return isStarting(listing.failureReason) ? <Starting /> : <Rows count={6} />
  }

  const entries = listing.data.untrusted.entries

  return (
    <TableFrame caption={`Files in ${place.path || 'the task'}`}>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="text-right">Modified</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const Icon = kindIcon[entry.kind]
          const path = joined(place.path, entry.name)
          const target =
            entry.kind === 'directory'
              ? {
                  path,
                  file: null,
                }
              : {
                  path: place.path,
                  file: path,
                }

          return (
            <TableRow key={entry.name} data-state={place.file === path ? 'selected' : undefined}>
              <TableCell className="max-w-0 w-full">
                <Link
                  {...taskTo(project, task, 'files', target)}
                  className="flex min-w-0 items-center gap-2 underline-offset-4 hover:underline"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-mono text-xs">{entry.name}</span>
                </Link>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
                {entry.size === null ? blank : bytes(entry.size)}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
                {shortAgo(entry.modified_at)}
              </TableCell>
            </TableRow>
          )
        })}
        {entries.length === 0 && (
          <TableRow>
            <TableCell colSpan={3} className="text-muted-foreground">
              Empty
            </TableCell>
          </TableRow>
        )}
        {listing.data.truncated && (
          <TableRow>
            <TableCell colSpan={3} className="text-muted-foreground">
              First {entries.length} entries
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </TableFrame>
  )
}

function Content({ task, file }: { task: string; file: string }) {
  const content = useQuery({
    queryKey: ['tasks', task, 'files', 'content', file],
    queryFn: () =>
      unwrap(
        filesOf(task).content.get({
          query: {
            path: file,
          },
        }),
      ),
    ...whileStarting,
  })

  if (content.error) {
    return (
      <Failure
        error={content.error}
        title="Couldn’t read this file"
        onRetry={() => void content.refetch()}
      />
    )
  }

  if (!content.data) {
    return isStarting(content.failureReason) ? <Starting /> : <Rows count={8} />
  }

  const shown = content.data

  return (
    <div className="flex min-w-0 flex-col overflow-hidden border">
      <div className="flex min-w-0 items-center gap-4 border-b px-3 py-2 text-xs">
        <code className="min-w-0 truncate font-mono text-xs">{shown.path}</code>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {bytes(shown.size)}
        </span>
        {shown.truncated && (
          <span className="shrink-0 text-muted-foreground">
            First {bytes(taskFileLimits.contentBytes)}
          </span>
        )}
        {shown.binary && <span className="shrink-0 text-muted-foreground">Binary</span>}
      </div>
      {shown.untrusted.text !== null && (
        <pre className="max-h-160 overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre">
          {shown.untrusted.text}
        </pre>
      )}
    </div>
  )
}

export function TaskFiles({
  project,
  task,
  place,
}: {
  project: string
  task: string
  place: TaskFilePlace
}) {
  return (
    <div className="flex flex-col gap-3 pb-6">
      <Crumbs project={project} task={task} place={place} />
      <div className={cn('grid gap-4', place.file && 'lg:grid-cols-2')}>
        <Directory project={project} task={task} place={place} />
        {place.file && <Content task={task} file={place.file} />}
      </div>
    </div>
  )
}
