import assert from 'node:assert/strict'
import { test } from 'node:test'

import { remedyCatalog } from '@stationly/protocol'

import type { NetworkMap } from '../src/lib/api.ts'
import {
  errorFix,
  findingPlan,
  findingRemedy,
  planFix,
  remedies,
  type FixContext,
} from '../src/lib/fixes.ts'

const context: FixContext = {
  project: 'shop',
  environment: 'production',
  subject: {
    kind: 'service',
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

type MapService = NetworkMap['services'][number]
type Finding = NetworkMap['warnings'][number]

const mapService = (name: string, status: MapService['status']) =>
  ({
    id: `svc_${name}`,
    name,
    status,
    station_id: 'sta_home',
  }) as MapService

test('every remedy in the catalog has a fix and nothing else does', () => {
  assert.deepEqual(Object.keys(remedies).sort(), [...remedyCatalog].sort())
})

test('raising memory is one click that patches the limits and redeploys', () => {
  const plan = planFix(
    {
      code: 'RAISE_MEMORY',
      text: 'Raise limits.memory_bytes to at least 1073741824.',
      action: {
        tool: 'update_service',
        input: {
          service: 'svc_web',
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
      tool: 'update_service',
      name: 'web',
      service: 'svc_web',
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
    'sly --project shop --environment production --service web services update --limits memory_bytes=1073741824',
  )
  assert.equal(
    plan.prompt,
    'In shop/production on Stationly, raise web’s memory limit to 1 GiB and redeploy it.',
  )
  assert.equal(plan.tool, 'update_service')
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
          service: 'svc_web',
          deployment_id: 'dep_12',
        },
      },
    },
    context,
  )
  assert.deepEqual(plan.button?.run, {
    tool: 'rollback',
    name: 'web',
    service: 'svc_web',
    deployment: 'dep_12',
  })
  assert.equal(
    plan.command,
    'sly --project shop --environment production --service web rollback --deployment-id dep_12 --wait',
  )
})

test('log fixes point at the failed deployment, and at its build for a build failure', () => {
  const fix = {
    code: 'READ_BUILD_LOGS',
    text: 'Read the build log.',
  }
  assert.equal(
    planFix(fix, context).command,
    'sly --project shop --environment production --service web logs --deployment dep_14',
  )
  assert.equal(
    planFix(fix, {
      ...context,
      deployment: {
        id: 'dep_14',
        build: 'bld_14',
      },
    }).command,
    'sly --project shop --environment production --service web logs --build bld_14',
  )
})

test('a fix for another service names that service in the button, command and prompt', () => {
  const plan = planFix(
    {
      code: 'START_TARGET',
      text: 'Start db; its current deployment is not running.',
      action: {
        tool: 'start_service',
        input: {
          service: 'svc_db',
        },
      },
    },
    context,
  )
  assert.equal(plan.button?.label, 'Start db')
  assert.equal(
    plan.command,
    'sly --project shop --environment production --service db services start',
  )
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
  assert.equal(plan.prompt, 'In shop/production on Stationly, help me with this: Do the new thing.')
})

test('a stopped service gets Start and a never-deployed one gets Deploy', () => {
  const finding = {
    code: 'SWITCH_NO_TARGET',
    explanation: 'web has no running deployment.',
    details: {
      service: 'web',
    },
  } as Finding
  const scope = {
    project: 'shop',
    environment: 'production',
  }
  assert.equal(
    findingPlan(finding, [mapService('web', 'stopped')], scope)?.button?.run.tool,
    'start_service',
  )
  assert.equal(findingPlan(finding, [mapService('web', 'red')], scope)?.button?.run.tool, 'deploy')
})

test('a missing public address offers the station command', () => {
  const plan = findingPlan(
    {
      code: 'NO_PUBLIC_ADDRESS',
      explanation: 'Station home has no public address.',
      details: {
        service: 'web',
        station: 'sta_home',
      },
    },
    [mapService('web', 'green')],
    {
      project: 'shop',
      environment: 'production',
    },
  )
  assert.equal(plan?.command, 'sly stations update sta_home --public-address <ipv4>')
})

test('findings without a remedy or a known service offer no fix', () => {
  assert.equal(findingRemedy.STATION_STALE, null)
  assert.equal(
    findingPlan(
      {
        code: 'SWITCH_NO_TARGET',
        explanation: 'gone has no running deployment.',
        details: {
          service: 'gone',
        },
      },
      [],
      {
        project: 'shop',
        environment: 'production',
      },
    ),
    null,
  )
})

test('error codes with a remedy map to a fix that keeps the API fix text', () => {
  assert.deepEqual(errorFix('SANDBOX_NOT_RUNNING', 'Start it first.'), {
    code: 'START_TARGET',
    text: 'Start it first.',
  })
  assert.equal(errorFix('STATION_OFFLINE', 'Wait for the station.'), null)
  const plan = planFix(errorFix('SANDBOX_NOT_RUNNING', 'Start it first.')!, {
    ...context,
    subject: {
      kind: 'sandbox',
      id: 'sbx_1',
      name: 'web-sbx',
    },
  })
  assert.deepEqual(plan.button?.run, {
    tool: 'start_sandbox',
    name: 'web-sbx',
    sandbox: 'sbx_1',
  })
  assert.equal(
    plan.command,
    'sly --project shop --environment production --sandbox web-sbx sandboxes start',
  )
})
