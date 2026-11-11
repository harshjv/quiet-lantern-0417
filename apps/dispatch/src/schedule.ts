import { Cron } from 'croner'

import type { Db } from './db/client.ts'
import { readSetting } from './db/settings.ts'
import type { Log } from './log.ts'

const logFailure = (log: Log, event: string) => (error: unknown) =>
  log(event, {
    explanation: (error as Error).message,
    stack: (error as Error).stack,
  })

export const every = (seconds: number, failure: string, log: Log, run: () => unknown) =>
  new Cron(
    '* * * * * *',
    {
      interval: seconds,
      protect: true,
      unref: true,
      catch: logFailure(log, failure),
    },
    async () => {
      await run()
    },
  )

export const runNow = (job: Cron) => {
  if (!job.isBusy()) {
    void job.trigger()
  }
}

export const settingSchedule = (
  db: Db,
  key: 'volume_backup.schedule' | 'registry.gc_schedule',
  log: Log,
  run: () => unknown,
) => {
  let pattern: string | null = null
  let job: Cron | null = null

  const follow = () => {
    const text = readSetting(db, key)

    if (text === pattern) {
      return
    }

    pattern = text
    job?.stop()
    job = null

    if (!text) {
      return
    }

    try {
      job = new Cron(
        text,
        {
          timezone: 'UTC',
          protect: true,
          unref: true,
          catch: logFailure(log, 'schedule.run_failed'),
        },
        async () => {
          await run()
        },
      )
      log('schedule.set', {
        setting: key,
        schedule: text,
        next: job.nextRun()?.toISOString() ?? null,
      })
    } catch (error) {
      log('schedule.invalid', {
        setting: key,
        schedule: text,
        explanation: (error as Error).message,
      })
    }
  }

  const watcher = every(5, 'schedule.follow_failed', log, follow)

  return {
    stop: () => {
      watcher.stop()
      job?.stop()
    },
  }
}
