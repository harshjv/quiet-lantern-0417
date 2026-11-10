import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let serviceId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h, 'station-1', {
    runOutput: ['[run] hi', '[run] bye'],
  })
  const environmentId = (await createProject(h)).default_environment_id
  const created = await createService(h, environmentId, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    deploy: true,
  })
  await waitForDeployment(h, created.deployments[0].id, 'active')
  serviceId = created.id
})

after(async () => {
  await h.close()
  registry.restore()
})

const events = (text: string) =>
  text
    .split('\n\n')
    .filter((block) => /^data: /m.test(block))
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!),
    }))

describe('output of a run that finished before its log stream opened', () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    test(`attempt ${attempt} delivers every line and then the end event`, async () => {
      const created = await h.call('POST', `/v1/services/${serviceId}/runs`, {
        token: h.admin.token,
        body: {
          command: ['echo', 'hi'],
          wait_s: 0,
        },
      })
      assert.equal(created.status, 201)
      const reply = await h.call('GET', `/v1/logs?run=${created.body.id}&tail=5000&follow=true`, {
        token: h.admin.token,
      })
      assert.equal(reply.status, 200)
      const seen = events(reply.text)
      assert.deepEqual(
        seen.filter((e) => e.event === 'log').map((e) => e.data.text),
        ['[run] hi', '[run] bye'],
      )
      assert.equal(seen.at(-1)?.event, 'end')
      assert.equal(seen.at(-1)?.data.reason, 'run_finished')
    })
  }
})
