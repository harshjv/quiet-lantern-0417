import assert from 'node:assert/strict'
import { test } from 'node:test'

import { breakingChanges, schemaBreaks, type Snapshot } from '../scripts/compat.ts'

type Node = Record<string, unknown>

const object = (properties: Record<string, Node>, required: string[] = [], extra: Node = {}) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
})

const changes = (base: Node, head: Node, defs: { base?: Node; head?: Node } = {}) =>
  schemaBreaks(
    (defs.base ?? {}) as Record<string, Node>,
    (defs.head ?? {}) as Record<string, Node>,
    base,
    head,
    '#',
  ).map((item) => `${item.at} ${item.change}`)

const name = {
  type: 'string',
}
const port = {
  type: 'integer',
  minimum: 1,
  maximum: 65535,
}
const nullable = (schema: Node) => ({
  anyOf: [
    schema,
    {
      type: 'null',
    },
  ],
})

const pairs: { name: string; base: Node; head: Node; breaks: string[] }[] = [
  {
    name: 'identical',
    base: object(
      {
        name,
      },
      ['name'],
    ),
    head: object(
      {
        name,
      },
      ['name'],
    ),
    breaks: [],
  },
  {
    name: 'new optional property',
    base: object({
      name,
    }),
    head: object({
      name,
      port,
    }),
    breaks: [],
  },
  {
    name: 'removed property',
    base: object({
      name,
      port,
    }),
    head: object({
      name,
    }),
    breaks: ['#/properties/port property removed'],
  },
  {
    name: 'property became required',
    base: object(
      {
        name,
        port,
      },
      ['name'],
    ),
    head: object(
      {
        name,
        port,
      },
      ['name', 'port'],
    ),
    breaks: ['#/properties/port property became required'],
  },
  {
    name: 'new required property',
    base: object(
      {
        name,
      },
      ['name'],
    ),
    head: object(
      {
        name,
        port,
      },
      ['name', 'port'],
    ),
    breaks: ['#/properties/port property became required'],
  },
  {
    name: 'required property became optional',
    base: object(
      {
        name,
      },
      ['name'],
    ),
    head: object({
      name,
    }),
    breaks: [],
  },
  {
    name: 'enum value added',
    base: {
      type: 'string',
      enum: ['a', 'b'],
    },
    head: {
      type: 'string',
      enum: ['a', 'b', 'c'],
    },
    breaks: [],
  },
  {
    name: 'enum value removed',
    base: {
      type: 'string',
      enum: ['a', 'b'],
    },
    head: {
      type: 'string',
      enum: ['a'],
    },
    breaks: ['# value "b" is no longer accepted'],
  },
  {
    name: 'const changed',
    base: {
      type: 'string',
      const: 'stationly-sandbox',
    },
    head: {
      type: 'string',
      const: 'sly-sandbox',
    },
    breaks: ['# const changed from "stationly-sandbox" to "sly-sandbox"'],
  },
  {
    name: 'type changed',
    base: {
      type: 'string',
    },
    head: {
      type: 'integer',
    },
    breaks: ['# type string is no longer accepted'],
  },
  {
    name: 'integer widened to number',
    base: {
      type: 'integer',
    },
    head: {
      type: 'number',
    },
    breaks: [],
  },
  {
    name: 'number narrowed to integer',
    base: {
      type: 'number',
    },
    head: {
      type: 'integer',
    },
    breaks: ['# type number is no longer accepted'],
  },
  {
    name: 'bounds narrowed',
    base: port,
    head: {
      type: 'integer',
      minimum: 1024,
      maximum: 65535,
    },
    breaks: ['# minimum raised from 1 to 1024'],
  },
  {
    name: 'bounds widened',
    base: {
      type: 'string',
      minLength: 3,
      maxLength: 10,
      pattern: '^a',
    },
    head: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      pattern: '^a',
    },
    breaks: [],
  },
  {
    name: 'pattern changed',
    base: {
      type: 'string',
      pattern: '^a',
    },
    head: {
      type: 'string',
      pattern: '^b',
    },
    breaks: ['# pattern changed from "^a" to "^b"'],
  },
  {
    name: 'became nullable',
    base: object({
      name,
    }),
    head: object({
      name: nullable(name),
    }),
    breaks: [],
  },
  {
    name: 'no longer nullable',
    base: object({
      name: nullable(name),
    }),
    head: object({
      name,
    }),
    breaks: ['#/properties/name/anyOf/1 type null is no longer accepted'],
  },
  {
    name: 'union member added',
    base: {
      anyOf: [
        object({
          kind: {
            type: 'string',
            const: 'a',
          },
        }),
      ],
    },
    head: {
      anyOf: [
        object({
          kind: {
            type: 'string',
            const: 'a',
          },
        }),
        object({
          kind: {
            type: 'string',
            const: 'b',
          },
        }),
      ],
    },
    breaks: [],
  },
  {
    name: 'union member removed',
    base: {
      anyOf: [
        object({
          kind: {
            type: 'string',
            const: 'a',
          },
        }),
        object({
          kind: {
            type: 'string',
            const: 'b',
          },
        }),
      ],
    },
    head: {
      anyOf: [
        object({
          kind: {
            type: 'string',
            const: 'a',
          },
        }),
      ],
    },
    breaks: ['#/anyOf/1/properties/kind const changed from "b" to "a"'],
  },
  {
    name: 'additionalProperties tightened',
    base: {
      type: 'object',
      additionalProperties: name,
    },
    head: {
      type: 'object',
      additionalProperties: false,
    },
    breaks: ['#/additionalProperties no longer accepts any value'],
  },
  {
    name: 'additionalProperties schema narrowed',
    base: {
      type: 'object',
      additionalProperties: name,
    },
    head: {
      type: 'object',
      additionalProperties: {
        type: 'integer',
      },
    },
    breaks: ['#/additionalProperties type string is no longer accepted'],
  },
  {
    name: 'additionalProperties loosened',
    base: object({
      name,
    }),
    head: object(
      {
        name,
      },
      [],
      {
        additionalProperties: true,
      },
    ),
    breaks: [],
  },
  {
    name: 'array items narrowed',
    base: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['a', 'b'],
      },
    },
    head: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['a'],
      },
      maxItems: 4,
    },
    breaks: ['# maxItems lowered from undefined to 4', '#/items value "b" is no longer accepted'],
  },
]

for (const pair of pairs)
  test(`schema pair: ${pair.name}`, () => {
    assert.deepEqual(changes(pair.base, pair.head), pair.breaks)
  })

test('a break inside a referenced definition is reported at the definition, once, through cycles', () => {
  const tree = (child: Node) => ({
    Tree: object({
      child,
      children: {
        type: 'array',
        items: {
          $ref: '#/$defs/Tree',
        },
      },
    }),
  })
  assert.deepEqual(
    changes(
      {
        $ref: '#/$defs/Tree',
      },
      {
        $ref: '#/$defs/Tree',
      },
      {
        base: tree({
          type: 'string',
          enum: ['a', 'b'],
        }),
        head: tree({
          type: 'string',
          enum: ['a'],
        }),
      },
    ),
    ['protocol.json#/$defs/Tree/properties/child value "b" is no longer accepted'],
  )
})

const snapshot = (
  defs: Record<string, Node>,
  messages: Snapshot['messages'],
  errors: Snapshot['errors'] = {
    errors: [],
    warnings: [],
  },
) => ({
  protocol: {
    $defs: defs,
  },
  messages,
  errors,
})

const message = (body: string) => ({
  from: 'station',
  body,
  capability: null,
  outboxed: false,
})

test('message types, root schemas and error codes', () => {
  const base = snapshot(
    {
      Envelope: object({
        type: name,
      }),
      HelloBody: object(
        {
          id: name,
        },
        ['id'],
      ),
      ByeBody: object({}),
    },
    {
      hello: message('HelloBody'),
      bye: message('ByeBody'),
    },
    {
      errors: [
        {
          code: 'GONE',
          http: 410,
          area: 'routing',
          close: null,
        },
      ],
      warnings: ['SLOW'],
    },
  )
  const head = snapshot(
    {
      Envelope: object({
        type: name,
        seq: port,
      }),
      Hello: object(
        {
          id: name,
        },
        ['id'],
      ),
      PingBody: object({}),
    },
    {
      hello: {
        ...message('Hello'),
        from: 'both',
      },
      ping: message('PingBody'),
    },
    {
      errors: [],
      warnings: ['SLOW', 'FAST'],
    },
  )
  assert.deepEqual(
    breakingChanges(base, head).map((item) => `${item.at} ${item.change}`),
    [
      'messages.json#/hello/from changed from "station" to "both"',
      'messages.json#/bye message type removed',
      'errors.json#/errors/GONE error code removed',
    ],
  )
})
