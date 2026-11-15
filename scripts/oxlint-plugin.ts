import { separators, spaceScale, typeScale } from '../apps/dashboard/src/next/tokens.ts'

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
  name?: { name?: string }
  key?: { name?: string; value?: unknown }
  expression?: Node
  callee?: { name?: string }
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
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }

  if (node.type === 'TemplateLiteral') {
    return node.quasis!.map((quasi) => quasi.value.cooked).join('{}')
  }

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

      if (text?.startsWith(apiPrefix) && passed(node) && !allowed.has(text)) {
        context.report({
          node,
          message: `${text} is a hand-built API path; call the typed Eden client, or use a URL the server returned`,
        })
      }
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

        if (!properties.length) {
          return
        }

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

        if (!inline.length) {
          return
        }

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

const spaces = new Set<string>([...spaceScale.map(([step]) => step), 'px', 'auto'])
const sizes = new Set<string>(typeScale.map(([name]) => name))
const palette =
  /^-?(text|bg|border|ring|fill|stroke|outline|from|to|via|decoration|divide|shadow)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)(-\d+)?(\/\d+)?$/
const spacing = /^-?(gap-[xy]|space-[xy]|gap|p[xytblrse]?|m[xytblrse]?)-(.+)$/
const fontSize = /^text-(xs|sm|base|lg|xl|\dxl)$/
const rawColor = /\b(rgba?|hsla?|oklch|oklab)\(/i

const classProblem = (token: string) => {
  const name = token.replace(/^!/, '').split(':').at(-1)!

  if (name.includes('[')) {
    return `${token} is a one-off value; pick one from the design catalogue`
  }

  if (/^rounded(-|$)/.test(name) && name !== 'rounded-none') {
    return `${token} rounds a corner; everything in the workbench is square`
  }

  const space = spacing.exec(name)

  if (space && !spaces.has(space[2]!)) {
    return `${token} is off the spacing scale (${[...spaces].join(', ')})`
  }

  if (fontSize.test(name) && !sizes.has(name)) {
    return `${token} is off the type scale (${[...sizes].join(', ')})`
  }

  if (palette.test(name)) {
    return `${token} is a raw palette colour; use a tone or brand token`
  }

  return null
}

const classCallees = new Set(['cn', 'cva', 'clsx'])

const inClassContext = (node: Node) => {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'JSXAttribute') {
      return at.name?.name === 'className'
    }

    if (at.type === 'CallExpression' && classCallees.has(at.callee?.name ?? '')) {
      return true
    }
  }

  return false
}

const designTokens = {
  meta: {
    type: 'problem',
    schema: [],
  },
  create(context: Context) {
    const checkText = (node: Node, text: string) => {
      if (rawColor.test(text)) {
        context.report({
          node,
          message: 'A raw colour; use a tone or brand token',
        })
      }

      const tokens = inClassContext(node) ? text.split(/\s+/).filter(Boolean) : []

      for (const token of tokens) {
        const problem = classProblem(token)

        if (problem) {
          context.report({
            node,
            message: problem,
          })
        }
      }

      const typed = separators.find((mark) =>
        mark === '|' ? text.trim() === mark : text.includes(mark),
      )

      if (typed) {
        context.report({
          node,
          message: `${typed} is a typed separator; set items apart with layout and icon facts`,
        })
      }
    }

    return {
      Literal(node: Node) {
        if (typeof node.value === 'string') {
          checkText(node, node.value)
        }
      },
      TemplateLiteral(node: Node) {
        for (const quasi of node.quasis!) {
          checkText(node, quasi.value.cooked)
        }
      },
      JSXText(node: Node) {
        checkText(node, String(node.value))
      },
      JSXAttribute(node: Node) {
        if (node.name?.name !== 'style') {
          return
        }

        const value = node.value as Node | undefined
        const style = value?.expression
        const heightOnly =
          style?.type === 'ObjectExpression' &&
          style.properties!.every((property) => property.key?.name === 'height')

        if (!heightOnly) {
          context.report({
            node,
            message: 'Inline styles bypass the catalogue; only a data-driven height may be inline',
          })
        }
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
    'design-tokens': designTokens,
  },
}
