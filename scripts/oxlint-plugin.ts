type Range = [number, number]

type Node = {
  type: string
  range: Range
  parent?: Node
  value?: unknown
  quasis?: { value: { cooked: string } }[]
  expressions?: unknown[]
  arguments?: Node[]
  properties?: Node[]
}

type Fix = { range: Range; text: string }

type Fixer = { insertTextAfterRange: (range: Range, text: string) => Fix }

type Context = {
  options: [{ allowed?: string[] }?]
  sourceCode: { text: string }
  report: (problem: { node: Node; message: string; fix?: (fixer: Fixer) => Fix[] }) => void
}

const apiPrefix = '/v1/'

const shape = (node: Node) => {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral')
    return node.quasis!.map((quasi) => quasi.value.cooked).join('{}')
  return null
}

const passed = (node: Node) =>
  (node.parent?.type === 'CallExpression' || node.parent?.type === 'NewExpression') &&
  node.parent.arguments!.includes(node)

const noLiteralApiPath = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          allowed: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context: Context) {
    const allowed = new Set(context.options[0]?.allowed ?? [])
    const check = (node: Node) => {
      const text = shape(node)
      if (text?.startsWith(apiPrefix) && passed(node) && !allowed.has(text))
        context.report({
          node,
          message: `${text} is a hand-built API path; call the typed Eden client, or use a URL the server returned`,
        })
    }
    return {
      Literal: check,
      TemplateLiteral: check,
    }
  },
}

const multilineObjectLiteral = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
  },
  create(context: Context) {
    return {
      ObjectExpression(node: Node) {
        const properties = node.properties!
        if (!properties.length) return
        const text = context.sourceCode.text
        const [start, end] = node.range
        const gaps: Range[] = [
          [start + 1, properties[0]!.range[0]],
          ...properties
            .slice(1)
            .map((property, i): Range => [properties[i]!.range[1], property.range[0]]),
          [properties.at(-1)!.range[1], end - 1],
        ]
        const inline = gaps.filter(([from, to]) => !text.slice(from, to).includes('\n'))
        if (!inline.length) return
        context.report({
          node,
          message:
            'Put a line break after {, each property on its own line, and a line break before }',
          fix: (fixer) => inline.map(([, to]) => fixer.insertTextAfterRange([to, to], '\n')),
        })
      },
    }
  },
}

export default {
  meta: {
    name: 'stationly',
  },
  rules: {
    'no-literal-api-path': noLiteralApiPath,
    'multiline-object-literal': multilineObjectLiteral,
  },
}
