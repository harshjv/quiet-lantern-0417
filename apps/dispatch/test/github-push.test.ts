import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { newId } from '../src/db/ids.ts'
import { app, approval, deployment, github_app, github_delivery } from '../src/db/schema.ts'
import { signatureOf } from '../src/github/client.ts'

import {
  addPerson,
  localOrigin,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import {
  approveWaiting,
  createProject,
  placed,
  productionId,
  seedShip,
  seedTask,
} from './helpers/seed.ts'

let h: Dispatch
let project: any
let other: any
let appId: string
let requester: string

const repo = 'github.com/acme/web'
const branch = 'main'
const githubAppId = 424242
const webhookSecret = randomBytes(24).toString('hex')

const shaOf = (seed: string) => seed.repeat(40).slice(0, 40)

const seedGitHubApp = () => {
  const id = newId('github_app')
  const privateKey = h.deps.github.seal(id, 'private_key', randomBytes(16).toString('hex'))
  const clientSecret = h.deps.github.seal(id, 'client_secret', randomBytes(16).toString('hex'))
  const hookSecret = h.deps.github.seal(id, 'webhook_secret', webhookSecret)

  h.db
    .insert(github_app)
    .values({
      id,
      app_id: githubAppId,
      slug: 'stationly-test',
      client_id: 'Iv1.test',
      owner: 'acme',
      webhooks: true,
      private_key: privateKey.ciphertext,
      client_secret: clientSecret.ciphertext,
      webhook_secret: hookSecret.ciphertext,
      data_key_id: hookSecret.data_key_id,
    })
    .run()
}

const ship = (
  projectId: string,
  status: 'waiting' | 'approved' | 'rejected',
  mergeSha: string | null,
) =>
  seedShip(
    h,
    seedTask(h, {
      project_id: projectId,
      owner: requester,
    }),
    {
      requester,
      status,
      ship: {
        merge_sha: mergeSha,
      },
    },
  ).id

const push = async (sha: string) => {
  const guid = randomUUID()
  const body = Buffer.from(
    JSON.stringify({
      ref: `refs/heads/${branch}`,
      after: sha,
      deleted: false,
      repository: {
        full_name: 'acme/web',
      },
    }),
  )
  const reply = await h.fetch(
    new Request(`${localOrigin}/github/webhook/${githubAppId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': guid,
        'x-hub-signature-256': signatureOf(webhookSecret, body),
      },
      body,
    }),
  )

  assert.equal(reply.status, 204, await reply.text())
  const deadline = Date.now() + 5000

  for (;;) {
    const row = h.db.select().from(github_delivery).where(eq(github_delivery.guid, guid)).get()

    if (row && row.status !== 'queued') {
      assert.equal(row.status, 'processed')

      return row
    }

    if (Date.now() > deadline) {
      throw new Error(`delivery ${guid} stayed queued`)
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const deploymentsOf = (sha: string) =>
  h.db
    .select()
    .from(deployment)
    .where(eq(deployment.app_id, appId))
    .all()
    .filter((d) => d.trigger.source_sha === sha)

const pushApprovalsFor = (sha: string) =>
  h.db
    .select()
    .from(approval)
    .where(and(eq(approval.project_id, project.id), eq(approval.source, 'api')))
    .all()
    .filter((row) => JSON.stringify(row.changes).includes(sha))

const requiresApproval = async (sha: string) => {
  await push(sha)

  assert.equal(deploymentsOf(sha).length, 0)
  assert.deepEqual(
    pushApprovalsFor(sha).map((row) => row.status),
    ['waiting'],
  )
}

before(async () => {
  h = await startDispatch()
  mock.method(h.deps.github, 'resolveRepo', () =>
    Promise.resolve({
      auth: 'public' as const,
      default_branch: branch,
    }),
  )
  seedGitHubApp()
  requester = (await addPerson(h, 'member@example.com', 'member')).userId
  await startFakeStation(h)
  project = await createProject(h, 'shop')
  other = await createProject(h, 'other')
  const created = await h.call('POST', placed(h, productionId(h, project.id), 'apps'), {
    token: h.admin.token,
    body: {
      name: 'web',
      kind: 'web',
      source: {
        type: 'dockerfile',
        repo,
        branch,
      },
      ports: [
        {
          port: 8080,
        },
      ],
      deploy_on_create: false,
    },
  })

  await approveWaiting(h, created)
  appId = h.db
    .select()
    .from(app)
    .where(and(eq(app.target_id, productionId(h, project.id)), eq(app.name, 'web')))
    .get()!.id
})

after(async () => {
  mock.restoreAll()
  await h.close()
})

describe('push to a production branch', () => {
  test('the merge of an approved Ship it deploys without a new approval and joins that approval', async () => {
    const mergeSha = shaOf('1')
    const shipId = ship(project.id, 'waiting', null)
    const merge = mock.method(h.deps.github, 'mergePullRequest', () => Promise.resolve(mergeSha))

    const decided = await h.call('POST', `/v1/approvals/${shipId}/decision`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        decision: 'approve',
      },
    })

    merge.mock.restore()
    assert.equal(decided.status, 200, decided.text)
    assert.equal(merge.mock.callCount(), 1)
    const shipped = h.db.select().from(approval).where(eq(approval.id, shipId)).get()!

    assert.equal(shipped.status, 'approved')
    assert.equal(shipped.ship?.merge_sha, mergeSha)
    await push(mergeSha)

    const made = deploymentsOf(mergeSha)

    assert.equal(made.length, 1)
    assert.deepEqual(
      pushApprovalsFor(mergeSha).map((row) => row.status),
      ['approved'],
    )
    const joined = h.db.select().from(approval).where(eq(approval.id, shipId)).get()!

    assert.deepEqual(
      joined.deployments,
      made.map((d) => d.id),
    )
  })

  test('a push of any other sha waits for approval', async () => {
    await requiresApproval(shaOf('b'))
  })

  test('the merge sha of a rejected Ship it waits for approval', async () => {
    const sha = shaOf('c')

    ship(project.id, 'rejected', sha)
    await requiresApproval(sha)
  })

  test('the merge sha of a still waiting Ship it waits for approval', async () => {
    const sha = shaOf('d')

    ship(project.id, 'waiting', sha)
    await requiresApproval(sha)
  })

  test('the merge sha of an approved Ship it in another project waits for approval', async () => {
    const sha = shaOf('f')

    ship(other.id, 'approved', sha)
    await requiresApproval(sha)
  })
})
