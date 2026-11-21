import assert from 'node:assert/strict'
import { test } from 'node:test'

import { remedyCatalog } from '@stationly/protocol'

import { errorFix, planFix, remedies, type FixContext } from '../src/lib/fixes.ts'

const context: FixContext = {
  project: 'shop',
  preview: null,
  subject: {
    kind: 'app',
    id: 'svc_web',
    name: 'web',
  },
  names: {
    svc_db: 'db',
  },
  deployment: {
    id: 'dep_14',
    build: null,
  },
}

test('every remedy in the catalog has a fix and nothing else does', () => {
  assert.deepEqual(Object.keys(remedies).sort(), [...remedyCatalog].sort())
})

test('raising memory is one click that patches the limits and redeploys', () => {
  const plan = planFix(
    {
      code: 'RAISE_MEMORY',
      text: 'Raise limits.memory_bytes to at least 1073741824.',
      action: {
        tool: 'update_app',
        input: {
          app: 'svc_web',
          limits: {
            memory_bytes: 1073741824,
            cpu_millis: 500,
          },
        },
      },
    },
    context,
  )

  assert.deepEqual(plan.button, {
    label: 'Raise memory to 1 GiB and redeploy',
    run: {
      tool: 'update_app',
      name: 'web',
      app: 'svc_web',
      body: {
        limits: {
          memory_bytes: 1073741824,
          cpu_millis: 500,
        },
      },
    },
  })
  assert.equal(
    plan.command,
    'sly --project shop --app web apps update --limits memory_bytes=1073741824',
  )
  assert.equal(
    plan.prompt,
    'In shop production on Stationly, raise web’s memory limit to 1 GiB and redeploy it.',
  )
  assert.equal(plan.tool, 'update_app')
})

test('a fix without structured input leaves the button out and keeps the prompt', () => {
  const plan = planFix(
    {
      code: 'RAISE_MEMORY',
      text: 'The kernel killed the run at the memory limit.',
    },
    context,
  )

  assert.equal(plan.button, null)
  assert.equal(plan.command, null)
  assert.match(plan.prompt, /raise web’s memory limit and redeploy it/)
})

test('rollback targets the last good deployment the diagnosis names', () => {
  const plan = planFix(
    {
      code: 'ROLLBACK',
      text: 'Deployment dep_12 was the last good one.',
      action: {
        tool: 'rollback',
        input: {
          app: 'svc_web',
          deployment_id: 'dep_12',
        },
      },
    },
    context,
  )

  assert.deepEqual(plan.button?.run, {
    tool: 'rollback',
    name: 'web',
    app: 'svc_web',
    deployment: 'dep_12',
  })
  assert.equal(plan.command, 'sly --project shop --app web rollback --deployment-id dep_12 --wait')
})

test('log fixes point at the failed deployment, and at its build for a build failure', () => {
  const fix = {
    code: 'READ_BUILD_LOGS',
    text: 'Read the build log.',
  }

  assert.equal(
    planFix(fix, context).command,
    'sly --project shop --app web logs --deployment dep_14',
  )
  assert.equal(
    planFix(fix, {
      ...context,
      deployment: {
        id: 'dep_14',
        build: 'bld_14',
      },
    }).command,
    'sly --project shop --app web logs --build bld_14',
  )
})

test('a fix for another app names that app in the button, command and prompt', () => {
  const plan = planFix(
    {
      code: 'START_TARGET',
      text: 'Start db; its current deployment is not running.',
      action: {
        tool: 'start_app',
        input: {
          app: 'svc_db',
        },
      },
    },
    context,
  )

  assert.equal(plan.button?.label, 'Start db')
  assert.equal(plan.command, 'sly --project shop --app db apps start')
  assert.match(plan.prompt, /start db and check/)
})

test('an unknown fix code still offers the agent prompt', () => {
  const plan = planFix(
    {
      code: 'SOMETHING_NEW',
      text: 'Do the new thing.',
    },
    context,
  )

  assert.equal(plan.button, null)
  assert.equal(plan.command, null)
  assert.equal(plan.prompt, 'In shop production on Stationly, help me with this: Do the new thing.')
})

test('error codes with a remedy map to a fix that keeps the API fix text', () => {
  assert.deepEqual(errorFix('NO_CURRENT_DEPLOYMENT', 'Deploy it first.'), {
    code: 'DEPLOY_TARGET',
    text: 'Deploy it first.',
  })
  assert.equal(errorFix('SERVER_OFFLINE', 'Wait for the station.'), null)
})
