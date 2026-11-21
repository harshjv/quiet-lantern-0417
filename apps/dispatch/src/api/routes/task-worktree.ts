import { and, eq } from 'drizzle-orm'
import { t } from 'elysia'

import { machineExecLimits, taskFileLimits } from '@stationly/protocol'

import { newId } from '../../db/ids.ts'
import { machine, run } from '../../db/schema.ts'
import { runStartBody } from '../../station/run-start.ts'
import type { StreamHandle } from '../../station/server.ts'
import {
  directoryEntries,
  fileText,
  parseTaskFileOutput,
  taskFileCommand,
  type TaskFileMode,
  type TaskFileRefusal,
} from '../../tasks/files.ts'
import {
  deliveredRun,
  machineUserOf,
  memberEnv,
  stationRunDelivery,
  taskRunAs,
  taskSetupReady,
} from '../../tasks/machine.ts'
import type { TaskRow } from '../../tasks/status.ts'
import { ownsTask, requireHuman } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { visibleTask } from '../lookup.ts'
import { activeMachineRuns, runRow } from '../runs.ts'
import { replies, TaskDirectory, TaskFile, TaskShell } from '../shapes.ts'
import { wakeMachine } from '../wake.ts'

import { stationError } from './runs.ts'

const fileRunTimeoutS = 30
const fileWaitS = 10
const fileOutputBytes = 2 * 1024 * 1024
const stdinChannel = 0
const stdoutChannel = 1

const pathQuery = t.Object({
  path: t.Optional(
    t.String({
      maxLength: taskFileLimits.pathBytes,
      pattern: '^[^\\x00]*$',
      description: "A path relative to the task's worktree; the worktree itself by default",
    }),
  ),
})

const refusals: Record<TaskFileRefusal, (path: string) => never> = {
  no_worktree: () =>
    invalid([
      {
        path: '/task',
        message: 'has no worktree yet; it is made while the task sets up',
      },
    ]),
  outside: () =>
    invalid([
      {
        path: '/path',
        message: "leaves the task's worktree",
      },
    ]),
  missing: (path) =>
    fail('NOT_FOUND', `${path || 'The worktree'} does not exist in the task's worktree.`),
  denied: (path) =>
    fail(
      'FORBIDDEN_SCOPE',
      `${path || 'The worktree'} cannot be read as the task's owner.`,
      'Open the Terminal tab and check its permissions.',
    ),
  not_directory: () =>
    invalid([
      {
        path: '/path',
        message: 'is not a directory; read it with files/content',
      },
    ]),
  not_file: () =>
    invalid([
      {
        path: '/path',
        message: 'is not a regular file',
      },
    ]),
}

type RunRow = typeof run.$inferSelect

export const taskWorktreeRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps

  const reach = (call: Call, row: TaskRow, refusal: string, limited: boolean) => {
    const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()

    wakeMachine(kit, call, box, `task ${row.title}`, refusal)

    if (box!.status !== 'running') {
      fail('MACHINE_NOT_RUNNING', `Task ${row.title} is starting.`, 'Retry in a few seconds.', {
        status: 'starting',
      })
    }

    const member = machineUserOf(db, row)
    const as = taskRunAs(box!, row, member)

    if (!taskSetupReady(db, row) || !as.worktree || (!row.isolated && !member)) {
      refusals.no_worktree('')
    }

    requireConnected(kit.deps, box!.server_id)

    if (limited && activeMachineRuns(db, box!.id) >= machineExecLimits.activeRuns) {
      fail(
        'RATE_LIMITED',
        `Task ${row.title} already has ${machineExecLimits.activeRuns} active runs on its server.`,
        'Wait for one to finish, then retry.',
        {
          limit: machineExecLimits.activeRuns,
        },
      )
    }

    return {
      box: box!,
      member,
      as: {
        ...as,
        worktree: as.worktree!,
      },
    }
  }

  const collectOutput = (stationId: string, row: RunRow, call: Call, signal: AbortSignal) =>
    new Promise<{ stdout: Buffer; exitCode: number | null; reason: string }>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let owed = 0
      let handle: StreamHandle | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = (reason: string) => {
        clearTimeout(timer)
        handle?.cancel()
        resolve({
          stdout: Buffer.concat(chunks),
          exitCode: null,
          reason,
        })
      }

      timer = setTimeout(() => stop(`no answer within ${fileWaitS} s`), fileWaitS * 1000)

      signal.addEventListener('abort', () => stop('the request was cancelled'), {
        once: true,
      })
      stations
        .startRun(
          stationId,
          runStartBody(row, call.principal.actor, {
            tty: false,
            attach: true,
            rows: null,
            cols: null,
          }),
          {
            onBinary: (channel, payload) => {
              if (channel === stdoutChannel && size <= fileOutputBytes) {
                chunks.push(payload)
                size += payload.length
              }

              if (handle) {
                handle.credit(payload.length)
              } else {
                owed += payload.length
              }
            },
            onEnd: (reason, exitCode) => {
              clearTimeout(timer)
              resolve({
                stdout: Buffer.concat(chunks),
                exitCode,
                reason,
              })
            },
          },
        )
        .then((started) => {
          handle = started.handle

          if (handle && owed) {
            handle.credit(owed)
          }

          handle?.write(stdinChannel, Buffer.alloc(0))
        })
        .catch((error: unknown) => {
          clearTimeout(timer)

          try {
            stationError(error)
          } catch (mapped) {
            reject(mapped instanceof Error ? mapped : new Error(String(mapped)))
          }
        })
    })

  const readWorktree = async (
    call: Call,
    row: TaskRow,
    path: string,
    mode: TaskFileMode,
    signal: AbortSignal,
  ) => {
    const { box, as } = reach(call, row, 'its files cannot be read', true)
    const id = newId('run')

    db.insert(run)
      .values({
        id,
        app_id: null,
        machine_id: box.id,
        deployment_id: null,
        kind: 'exec',
        command: taskFileCommand(as.worktree, path, mode),
        status: 'queued',
        log_ref: `logs/sandboxes/${box.id}/${id}`,
        tty: false,
        actor: call.principal.actor,
        exec: {
          cwd: as.home,
          user: as.user,
          timeout_s: fileRunTimeoutS,
          stdin: null,
          env_keys: [],
          attach: true,
          task_id: row.id,
          record: false,
        },
      })
      .run()

    const ended = await collectOutput(box.server_id, runRow(db, id), call, signal).finally(() =>
      db
        .update(run)
        .set({
          status: 'cancelled',
        })
        .where(and(eq(run.id, id), eq(run.status, 'queued')))
        .run(),
    )

    if (ended.exitCode !== 0) {
      fail(
        'SERVER_OFFLINE',
        `Reading the files of task ${row.title} did not finish: ${ended.reason}.`,
        'Retry. If it keeps failing, check the server on the Servers page.',
        {
          run_id: id,
          reason: ended.reason,
        },
      )
    }

    const output = parseTaskFileOutput(ended.stdout.toString('utf8').split('\n').filter(Boolean))

    if (!output) {
      fail('INTERNAL_ERROR', `The file reader in task ${row.title} printed no result.`)
    }

    if (output!.refused) {
      refusals[output!.refused](path)
    }

    return {
      ...(output as Extract<typeof output, { refused: null }>),
      redact: kit.machineRedaction([box.id], call.principal.actor, call.request_id),
    }
  }

  return kit
    .router('tasks', '/v1')
    .post(
      '/tasks/:task/shells',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'A shell in a task')

        const row = visibleTask(db, call.principal, params.task)

        if (!ownsTask(call.principal, row)) {
          fail(
            'FORBIDDEN_SCOPE',
            `Only the owner of task ${row.title} can open a shell in it.`,
            'Ask its owner, or start a task of your own.',
          )
        }

        const { box, member, as } = reach(call, row, 'no shell can open in it', false)
        const id = newId('run')
        const delivered = await deliveredRun(stationRunDelivery(stations), box, id, [
          ['HOME', as.home],
          ...(row.port ? ([['PORT', String(row.port)]] as [string, string][]) : []),
          ...(member ? memberEnv(member) : []),
        ]).catch(stationError)
        const command = ['/bin/bash', '-l']

        db.insert(run)
          .values({
            id,
            app_id: null,
            machine_id: box.id,
            deployment_id: null,
            kind: 'shell',
            command,
            status: 'queued',
            log_ref: `logs/sandboxes/${box.id}/${id}`,
            tty: true,
            actor: call.principal.actor,
            exec: {
              cwd: as.worktree,
              user: as.user,
              timeout_s: null,
              stdin: null,
              env_keys: delivered.envKeys,
              attach: true,
              task_id: row.id,
              record: false,
            },
          })
          .run()
        audit(
          db,
          call,
          'task.shell',
          {
            entity: 'task',
            id: row.id,
          },
          {
            after: {
              run_id: id,
              machine_id: box.id,
              user: as.user,
            },
          },
        )
        set.status = 201

        return {
          ...select(kit.views.run, runRow(db, id), undefined),
          tty: true,
          attach_url: `/v1/runs/${id}/attach`,
        }
      },
      {
        operation: {
          id: 'open_task_shell',
          summary:
            "Open a shell in a task's worktree as the task's owner, who alone may; attach to it over the WebSocket at attach_url",
          level: 'any',
          mcp: false,
          cli: false,
        },
        response: replies({
          201: TaskShell,
        }),
      },
    )
    .get(
      '/tasks/:task/files',
      async ({ params, query, request }) => {
        const call = await kit.call(request)
        const row = visibleTask(db, call.principal, params.task)
        const path = query.path ?? ''
        const read = await readWorktree(call, row, path, 'list', request.signal)
        const entries = directoryEntries(read.body, read.redact)

        return {
          path,
          untrusted: {
            source: 'task worktree' as const,
            entries,
          },
          truncated: (read.head.count ?? entries.length) > entries.length,
        }
      },
      {
        operation: {
          id: 'list_task_files',
          summary:
            "List a directory of a task's worktree, directories first, without following symlinks; for the task's owner or an admin",
          level: 'any',
          mcp: false,
          cli: {
            path: ['tasks', 'files'],
            args: ['task'],
          },
        },
        query: pathQuery,
        response: replies({
          200: TaskDirectory,
        }),
      },
    )
    .get(
      '/tasks/:task/files/content',
      async ({ params, query, request }) => {
        const call = await kit.call(request)
        const row = visibleTask(db, call.principal, params.task)
        const path = query.path ?? ''
        const read = await readWorktree(call, row, path, 'read', request.signal)
        const size = read.head.size ?? read.body.length
        const truncated = size > read.body.length
        const text = fileText(read.body, truncated)

        return {
          path,
          size,
          binary: text === null,
          truncated,
          untrusted: {
            source: 'task worktree' as const,
            text: text === null ? null : read.redact(text),
          },
        }
      },
      {
        operation: {
          id: 'read_task_file',
          summary: `Read a file of a task's worktree, its first ${taskFileLimits.contentBytes / 1024} KiB; a path that leaves the worktree, symlinks included, is refused. For the task's owner or an admin`,
          level: 'any',
          mcp: false,
          cli: {
            path: ['tasks', 'read'],
            args: ['task'],
          },
        },
        query: pathQuery,
        response: replies({
          200: TaskFile,
        }),
      },
    )
}
