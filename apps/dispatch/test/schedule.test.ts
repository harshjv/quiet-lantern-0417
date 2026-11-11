import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { every, runNow } from '../src/schedule.ts'

test('a job never overlaps itself, whether the schedule or runNow starts it', async () => {
  let started = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const job = every(
    1,
    'test.failed',
    () => {},
    async () => {
      started++
      await gate
    },
  )

  runNow(job)
  runNow(job)
  await sleep(1_200)
  assert.equal(started, 1)

  release()
  await sleep(10)
  const before = started

  runNow(job)
  assert.equal(started, before + 1)
  job.stop()
})

test('a failing run is logged and the job keeps its schedule', async () => {
  const logged: { event: string; fields?: Record<string, unknown> }[] = []
  const job = every(
    3600,
    'test.failed',
    (event, fields) =>
      logged.push({
        event,
        fields,
      }),
    () => {
      throw new Error('boom')
    },
  )

  runNow(job)
  await sleep(10)
  assert.equal(logged[0]?.event, 'test.failed')
  assert.equal(logged[0]?.fields?.explanation, 'boom')
  assert.ok(job.isRunning())
  job.stop()
})
