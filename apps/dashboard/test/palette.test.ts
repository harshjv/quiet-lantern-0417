import assert from 'node:assert/strict'
import { test } from 'node:test'

import { destinations, pageProject, pageText, type Page, type Space } from '../src/lib/palette.ts'

const space: Space = {
  project: 'shop',
  preview: null,
  apps: [
    {
      id: 'svc_web',
      name: 'web',
    },
    {
      id: 'svc_api',
      name: 'api',
    },
  ],
  machines: [
    {
      id: 'sbx_try',
      name: 'try',
    },
  ],
  deployments: [
    {
      id: 'dep_13',
      number: 13,
      app_id: 'svc_web',
    },
    {
      id: 'dep_gone',
      number: 2,
      app_id: 'svc_gone',
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

test('projects and apps are sorted by name', () => {
  assert.deepEqual(
    found.projects.map((entry) => entry.label),
    ['blog', 'shop'],
  )
  assert.deepEqual(
    found.apps.map((entry) => entry.label),
    ['api', 'web'],
  )
})

test('every destination has a unique value', () => {
  const values = Object.values(found).flatMap((list) => list.map((entry) => entry.value))

  assert.equal(new Set(values).size, values.length)
})

test('entities carry where they live and link by id', () => {
  assert.deepEqual(found.places[0], {
    value: 'shop/production',
    label: 'shop / production',
    to: {
      to: '/projects/$project/{-$tab}',
      params: {
        project: 'shop',
        tab: undefined,
      },
    },
  })
  assert.equal(found.apps[0].hint, 'shop / production')
  assert.deepEqual(found.machines[0].to, {
    to: '/machines/$machine/{-$tab}',
    params: {
      machine: 'sbx_try',
      tab: undefined,
    },
  })
})

test('deployments are named after their app and skip unknown apps', () => {
  assert.deepEqual(
    found.deployments.map((entry) => entry.label),
    ['web #13'],
  )
})

const scope = {
  project: 'shop',
  preview: 'staging',
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
    kind: 'place',
    scope,
  },
  {
    kind: 'app',
    scope: {
      ...scope,
      app: 'web',
    },
  },
  {
    kind: 'machine',
    scope,
    machine: 'try',
  },
]

test('every page has a sly command', () => {
  for (const page of pages) {
    assert.match(pageText(page).command, /^sly /, page.kind)
  }
})

test('pages name their app, preview or machine in the command', () => {
  const app = pageText(pages[3])

  assert.match(app.command, /--app web/)
  assert.match(app.prompt ?? '', /web in the staging preview of shop/)
  assert.match(pageText(pages[2]).command, /--preview staging/)
  assert.match(pageText(pages[4]).command, /--machine try/)
})

test('the page project comes from its scope', () => {
  assert.deepEqual(pages.map(pageProject), [null, 'shop', 'shop', 'shop', 'shop'])
})
