import { taskFileLimits, type taskFileKindValues } from '@stationly/protocol'

export type TaskFileMode = 'list' | 'read'

const chunkChars = 12_000

const reader = String.raw`
import base64, json, os, stat, sys

root, rel, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cap, limit, width = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])


def emit(head, body=b""):
    print(json.dumps(head))
    data = base64.b64encode(body).decode()
    for start in range(0, len(data), width):
        print(data[start:start + width])
    sys.exit(0)


def kind_of(entry):
    if entry.is_symlink():
        return "symlink"
    if entry.is_dir(follow_symlinks=False):
        return "directory"
    if entry.is_file(follow_symlinks=False):
        return "file"
    return "other"


if not os.path.isdir(root):
    emit({"error": "no_worktree"})
base = os.path.realpath(root)
path = os.path.realpath(os.path.join(base, rel))
if path != base and not path.startswith(base + os.sep):
    emit({"error": "outside"})
try:
    info = os.stat(path)
except FileNotFoundError:
    emit({"error": "missing"})
except OSError:
    emit({"error": "denied"})
try:
    if mode == "list":
        if not stat.S_ISDIR(info.st_mode):
            emit({"error": "not_directory"})
        rows = []
        with os.scandir(path) as found:
            for entry in found:
                meta = entry.stat(follow_symlinks=False)
                kind = kind_of(entry)
                rows.append([entry.name, kind, meta.st_size if kind == "file" else None, meta.st_mtime])
        rows.sort(key=lambda row: (row[1] != "directory", row[0]))
        emit({"count": len(rows)}, json.dumps(rows[:limit]).encode())
    if not stat.S_ISREG(info.st_mode):
        emit({"error": "not_file"})
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
        emit({"size": info.st_size}, handle.read(cap))
except OSError:
    emit({"error": "denied"})
`

export const taskFileCommand = (worktree: string, path: string, mode: TaskFileMode) => [
  'python3',
  '-I',
  '-c',
  reader,
  worktree,
  path || '.',
  mode,
  String(taskFileLimits.contentBytes),
  String(taskFileLimits.entries),
  String(chunkChars),
]

export type TaskFileRefusal =
  'no_worktree' | 'outside' | 'missing' | 'denied' | 'not_directory' | 'not_file'

type Head = { error: TaskFileRefusal } | { count: number } | { size: number }

export type TaskFileOutput =
  | { refused: TaskFileRefusal }
  | { refused: null; head: { count?: number; size?: number }; body: Buffer }

export const parseTaskFileOutput = (lines: string[]): TaskFileOutput | null => {
  const [first, ...rest] = lines

  if (first === undefined) {
    return null
  }

  let head: Head

  try {
    head = JSON.parse(first) as Head
  } catch {
    return null
  }

  if ('error' in head) {
    return {
      refused: head.error,
    }
  }

  return {
    refused: null,
    head,
    body: Buffer.from(rest.join(''), 'base64'),
  }
}

type EntryKind = (typeof taskFileKindValues)[number]

export const directoryEntries = (body: Buffer, redact: (text: string) => string) =>
  (JSON.parse(body.toString('utf8')) as [string, EntryKind, number | null, number][]).map(
    ([name, kind, size, modified]) => ({
      name: redact(name),
      kind,
      size,
      modified_at: new Date(modified * 1000).toISOString(),
    }),
  )

const strict = new TextDecoder('utf-8', {
  fatal: true,
})

export const fileText = (body: Buffer, truncated: boolean) => {
  if (body.includes(0)) {
    return null
  }

  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= body.length; cut += 1) {
    try {
      return strict.decode(body.subarray(0, body.length - cut))
    } catch {
      continue
    }
  }

  return null
}
