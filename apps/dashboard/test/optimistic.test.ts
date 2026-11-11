import assert from 'node:assert/strict'
import { test } from 'node:test'

import { QueryClient, queryOptions } from '@tanstack/react-query'

import type { Deployment, DeploymentStep, Event, Variable } from '../src/lib/api.ts'
import {
  applyOptimistic,
  isOptimistic,
  merge,
  mergeItem,
  prependItem,
  rollback,
} from '../src/lib/cache.ts'
import { completionOf, completionText, startedByAgent } from '../src/lib/completion.ts'
import { stepProgress, withQueued } from '../src/lib/status.ts'
import { withDraft, withoutKeys } from '../src/lib/variables.ts'

type Row = { id: string; on: boolean }

const listQuery = queryOptions({
  queryKey: ['rows'],
  queryFn: (): { items: Row[] } => ({
    items: [],
  }),
})

const oneQuery = queryOptions({
  queryKey: ['rows', 'a'],
  queryFn: (): Row => ({
    id: 'a',
    on: false,
  }),
})

const cached = () => {
  const client = new QueryClient()

  client.setQueryData(listQuery.queryKey, {
    items: [
      {
        id: 'a',
        on: false,
      },
      {
        id: 'b',
        on: false,
      },
    ],
  })
  client.setQueryData(oneQuery.queryKey, {
    id: 'a',
    on: false,
  })

  return client
}

test('an optimistic edit writes every cached query and a rollback restores them', async () => {
  const client = cached()
  const snapshot = await applyOptimistic(client, [
    mergeItem(listQuery, 'a', {
      on: true,
    }),
    merge(oneQuery, {
      on: true,
    }),
  ])

  assert.deepEqual(
    client.getQueryData(listQuery.queryKey)?.items.map((row) => row.on),
    [true, false],
  )
  assert.equal(client.getQueryData(oneQuery.queryKey)?.on, true)
  rollback(client, snapshot)
  assert.deepEqual(
    client.getQueryData(listQuery.queryKey)?.items.map((row) => row.on),
    [false, false],
  )
  assert.equal(client.getQueryData(oneQuery.queryKey)?.on, false)
})

test('an optimistic edit leaves queries that are not cached alone', async () => {
  const client = new QueryClient()

  await applyOptimistic(client, [
    merge(oneQuery, {
      on: true,
    }),
    prependItem(listQuery, () => ({
      id: 'c',
      on: true,
    })),
  ])
  assert.equal(client.getQueryData(oneQuery.queryKey), undefined)
  assert.equal(client.getQueryData(listQuery.queryKey), undefined)
})

const deployment = (number: number): Deployment => ({
  id: `dep_${number}`,
  service_id: 'svc_web',
  number,
  status: 'active',
  trigger: {
    type: 'manual',
    source_sha: null,
  },
  strategy: 'replace',
  image_ref: null,
  cancel_reason: null,
  started_at: null,
  finished_at: null,
})

test('a deploy queues a placeholder above the latest deployment', () => {
  const [queued, ...rest] = withQueued(
    [deployment(4), deployment(3)],
    'redeploy',
    '2026-11-10T00:00:00Z',
  )

  assert.ok(queued && isOptimistic(queued))
  assert.equal(queued.number, 5)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.trigger.type, 'redeploy')
  assert.equal(queued.strategy, 'replace')
  assert.equal(rest.length, 2)
  assert.deepEqual(withQueued([], 'manual'), [])
})

const variable = (key: string): Variable => ({
  id: `var_${key}`,
  scope: 'service',
  key,
  kind: 'literal',
  reference: null,
  injection: 'file',
  build: false,
  head_version: 2,
  bytes: null,
})

test('a saved variable shows as a draft until the server answers', () => {
  const list = [variable('A')]
  const added = withDraft(
    list,
    {
      key: 'B',
      kind: 'reference',
      value: '${{db.HOST}}',
      build: true,
    },
    'service',
  )

  assert.equal(added.length, 2)
  assert.ok(isOptimistic(added[1]))
  assert.equal(added[1].reference, '${{db.HOST}}')
  assert.equal(added[1].injection, 'env')
  const changed = withDraft(
    list,
    {
      key: 'A',
      kind: 'literal',
      value: 'two',
      build: false,
    },
    'service',
  )

  assert.equal(changed.length, 1)
  assert.equal(changed[0].id, 'var_A')
  assert.equal(changed[0].injection, 'file')
  assert.ok(isOptimistic(changed[0]))
  assert.ok(!isOptimistic(list[0]))
  assert.deepEqual(
    withoutKeys(added, ['A']).map((v) => v.key),
    ['B'],
  )
})

const event = (
  type: string,
  payload: Record<string, unknown>,
): Pick<Event, 'type' | 'subject' | 'payload'> => ({
  type,
  subject: {
    entity: 'deployment',
    id: 'dep_14',
  },
  payload,
})

test('only finished deployments make a completion', () => {
  assert.deepEqual(
    completionOf(
      event('deployment.active', {
        number: 14,
      }),
    ),
    {
      deployment: 'dep_14',
      number: 14,
      outcome: 'active',
    },
  )
  assert.equal(
    completionOf(
      event('deployment.started', {
        number: 14,
      }),
    ),
    null,
  )
  assert.equal(completionOf(event('deployment.failed', {})), null)
})

test('completion toasts name the service and the deployment', () => {
  assert.deepEqual(
    completionText(
      {
        deployment: 'dep_14',
        number: 14,
        outcome: 'active',
      },
      'web',
    ),
    {
      title: 'web is live',
      description: 'Deployment #14',
      action: 'Open',
    },
  )
  assert.equal(
    completionText(
      {
        deployment: 'dep_14',
        number: 14,
        outcome: 'failed',
      },
      'web',
    ).action,
    'See why',
  )
})

test('agent deployments are the ones started by an agent token or client', () => {
  assert.ok(
    startedByAgent({
      type: 'agent',
      source_sha: null,
    }),
  )
  assert.ok(
    !startedByAgent({
      type: 'manual',
      source_sha: null,
    }),
  )
})

const step = (name: DeploymentStep['step'], status: DeploymentStep['status']) =>
  ({
    id: `${name}-${status}`,
    step: name,
    status,
    attempt: 1,
    started_at: status === 'pending' ? null : '2026-11-10T00:00:00Z',
    finished_at: null,
  }) as DeploymentStep

test('the step header counts distinct steps and times the running one', () => {
  const steps = [
    step('pull', 'done'),
    step('pre_deploy', 'skipped'),
    step('service', 'done'),
    step('health', 'failed'),
    step('health', 'running'),
    step('cutover', 'pending'),
  ]

  assert.equal(
    stepProgress(steps, new Date('2026-11-10T00:00:12Z')),
    'Step 3 of 4 · Health check · 12 s',
  )
  assert.equal(stepProgress([step('pull', 'done')]), null)
})
