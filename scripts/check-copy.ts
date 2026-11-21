import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'

import { collectStrings, words } from './copy-catalogue.ts'

const root = 'apps/dashboard'
const budgetFile = `${root}/copy-budget.json`
const rerun = 'pnpm check:copy --write'

const counts = new Map<string, number>()

for (const entry of collectStrings(['dashboard']).strings) {
  const page = relative(root, entry.file)

  counts.set(page, (counts.get(page) ?? 0) + words(entry.text))
}

const pages = [...counts.keys()].sort()
const total = pages.reduce((sum, page) => sum + counts.get(page)!, 0)

if (process.argv.includes('--write')) {
  const budget = Object.fromEntries(pages.map((page) => [page, counts.get(page)!]))

  writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`)
  process.stdout.write(`wrote ${budgetFile}: ${pages.length} pages, ${total} words\n`)
  process.exit(0)
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8')) as Record<string, number>
const over = pages
  .map((page) => ({
    page,
    count: counts.get(page)!,
    allowed: budget[page] ?? 0,
  }))
  .filter(({ count, allowed }) => count > allowed)

if (over.length) {
  for (const { page, count, allowed } of over) {
    process.stderr.write(
      `${root}/${page}: ${count} words, over its budget of ${allowed} in ${budgetFile}\n`,
    )
  }

  process.stderr.write(
    `Cut the words, or once the new words are decided, raise the budget with \`${rerun}\` and commit ${budgetFile}.\n`,
  )
  process.exit(1)
}

process.stdout.write(`${pages.length} pages, ${total} words, all within ${budgetFile}\n`)
