import assert from 'node:assert/strict'
import { test } from 'node:test'

import { destinations, pageProject, pageText, type Page, type Space } from '../src/lib/palette.ts'

const space: Space = {
  project: 'shop',
  environment: {
    id: 'env_prod',
    name: 'production',
  },
  services: [
    {
      id: 'svc_web',
      name: 'web',
    },
    {
      id: 'svc_api',
      name: 'api',
    },
  ],
  sandboxes: [
    {
      id: 'sbx_try',
      name: 'try',
    },
  ],
  deployments: [
    {
      id: 'dep_13',
      number: 13,
      service_id: 'svc_web',
    },
    {
      id: 'dep_gone',
      number: 2,
      service_id: 'svc_gone',
    },
  ],
}

const found = destinations(
  [
    {
      id: 'prj_shop',
      name: 'shop',
    },
    {
      id: 'prj_blog',
      name: 'blog',
    },
  ],
  [space],
)

test('projects and services are sorted by name', () => {
  assert.deepEqual(
    found.projects.map((entry) => entry.label),
    ['blog', 'shop'],
  )
  assert.deepEqual(
    found.services.map((entry) => entry.label),
    ['api', 'web'],
  )
})

test('every destination has a unique value', () => {
  const values = Object.values(found).flatMap((list) => list.map((entry) => entry.value))

  assert.equal(new Set(values).size, values.length)
})

test('entities carry where they live and link by id', () => {
  assert.deepEqual(found.environments[0], {
    value: 'env_prod',
    label: 'shop / production',
    link: {
      to: '/projects/$project/$environment',
      params: {
        project: 'shop',
        environment: 'production',
      },
    },
  })
  assert.equal(found.services[0].hint, 'shop / production')
  assert.deepEqual(found.sandboxes[0].link, {
    to: '/sandboxes/$sandbox',
    params: {
      sandbox: 'sbx_try',
    },
  })
})

test('deployments are named after their service and skip unknown services', () => {
  assert.deepEqual(
    found.deployments.map((entry) => entry.label),
    ['web #13'],
  )
})

const scope = {
  project: 'shop',
  environment: 'production',
}

const pages: Page[] = [
  {
    kind: 'projects',
  },
  {
    kind: 'project',
    project: 'shop',
  },
  {
    kind: 'environment',
    scope,
  },
  {
    kind: 'service',
    scope: {
      ...scope,
      service: 'web',
    },
  },
  {
    kind: 'sandbox',
    scope,
    sandbox: 'try',
  },
]

test('every page has a sly command', () => {
  for (const page of pages) {
    assert.match(pageText(page).command, /^sly /, page.kind)
  }
})

test('pages name their service, environment or sandbox in the command', () => {
  const service = pageText(pages[3])

  assert.match(service.command, /--service web/)
  assert.match(service.prompt ?? '', /web in shop\/production/)
  assert.match(pageText(pages[2]).command, /--environment production/)
  assert.match(pageText(pages[4]).command, /--sandbox try/)
})

test('the page project comes from its scope', () => {
  assert.deepEqual(pages.map(pageProject), [null, 'shop', 'shop', 'shop', 'shop'])
})
