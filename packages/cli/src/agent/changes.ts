import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type Snapshot = { tree: string; head: string | null }

export type TurnChanges = {
  files: { path: string; added: number | null; removed: number | null; diff?: string }[]
  more_files?: number
  commits: { sha: string; subject: string }[]
  truncated?: boolean
}

export type ChangeReader = {
  snapshot: () => Promise<Snapshot | null>
  between: (before: Snapshot, after: Snapshot) => Promise<TurnChanges | null>
}

const diffBytes = 2048
const budgetBytes = 14 * 1024
const maxFiles = 50
const maxCommits = 20
const maxBuffer = 32 * 1024 * 1024

const cut = (text: string, bytes: number) => {
  const buffer = Buffer.from(text)

  return buffer.length <= bytes
    ? text
    : buffer.subarray(0, bytes).toString('utf8').replace(/�$/, '')
}

export const gitChanges = (cwd: string): ChangeReader => {
  const git = async (args: string[], env: NodeJS.ProcessEnv = {}) =>
    (
      await run('git', args, {
        cwd,
        env: {
          ...process.env,
          ...env,
        },
        maxBuffer,
      })
    ).stdout

  const snapshot = async (): Promise<Snapshot | null> => {
    const dir = await mkdtemp(join(tmpdir(), 'turn-'))
    const index = join(dir, 'index')

    try {
      const own = (await git(['rev-parse', '--git-path', 'index'])).trim()

      await copyFile(isAbsolute(own) ? own : join(cwd, own), index).catch(() => undefined)

      const env = {
        GIT_INDEX_FILE: index,
      }

      await git(['add', '-A'], env)

      const tree = (await git(['write-tree'], env)).trim()
      const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()

      return {
        tree,
        head: head || null,
      }
    } catch {
      return null
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      })
    }
  }

  const between = async (before: Snapshot, after: Snapshot): Promise<TurnChanges | null> => {
    try {
      const numstat =
        before.tree === after.tree ? '' : await git(['diff', '--numstat', before.tree, after.tree])
      const commits =
        before.head && after.head && before.head !== after.head
          ? (
              await git([
                'log',
                '--format=%H%x09%s',
                `-${maxCommits}`,
                `${before.head}..${after.head}`,
              ])
            )
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const [sha = '', ...rest] = line.split('\t')

                return {
                  sha,
                  subject: rest.join('\t'),
                }
              })
          : []
      const listed = numstat
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [added = '-', removed = '-', ...path] = line.split('\t')

          return {
            path: path.join('\t'),
            added: added === '-' ? null : Number(added),
            removed: removed === '-' ? null : Number(removed),
          }
        })

      if (!listed.length && !commits.length) {
        return null
      }

      let budget = budgetBytes
      let truncated = false
      const files: TurnChanges['files'] = []

      for (const file of listed.slice(0, maxFiles)) {
        if (budget <= 0 || file.added === null) {
          files.push(file)
          truncated ||= budget <= 0
          continue
        }

        const full = await git(['diff', before.tree, after.tree, '--', file.path])
        const diff = cut(full, Math.min(diffBytes, budget))

        truncated ||= diff !== full
        budget -= Buffer.byteLength(diff) + Buffer.byteLength(file.path) + 64
        files.push({
          ...file,
          diff,
        })
      }

      return {
        files,
        ...(listed.length > maxFiles
          ? {
              more_files: listed.length - maxFiles,
            }
          : {}),
        commits,
        ...(truncated || listed.length > maxFiles
          ? {
              truncated: true,
            }
          : {}),
      }
    } catch {
      return null
    }
  }

  return {
    snapshot,
    between,
  }
}
