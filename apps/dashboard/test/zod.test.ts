import assert from 'node:assert/strict'
import { test } from 'node:test'

import { z } from '../src/lib/zod.ts'

test('parsing a search schema never builds a function from a string, which the CSP refuses', () => {
  const original = globalThis.Function
  const built: unknown[][] = []

  globalThis.Function = new Proxy(original, {
    construct: (target, args: unknown[]) => {
      built.push(args)

      return Reflect.construct(target, args) as object
    },
    apply: (target, self, args: unknown[]) => {
      built.push(args)

      return Reflect.apply(target, self, args) as unknown
    },
  })

  try {
    const schema = z.object({
      tab: z.enum(['overview', 'logs']).default('overview').catch('overview'),
      redirect: z.string().optional(),
    })

    assert.deepEqual(schema.parse({}), {
      tab: 'overview',
    })
    assert.deepEqual(schema.parse({}), {
      tab: 'overview',
    })
  } finally {
    globalThis.Function = original
  }

  assert.deepEqual(built, [])
})
