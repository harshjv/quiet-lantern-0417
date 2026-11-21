import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxText,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isTemplateSpan,
  isVariableDeclaration,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'

export type Surface = 'dashboard' | 'cli' | 'api'

export type Kind =
  | 'heading'
  | 'button'
  | 'label'
  | 'body'
  | 'placeholder'
  | 'status'
  | 'error'
  | 'fix'
  | 'help'
  | 'description'
  | 'toast'
  | 'other'

export type Entry = {
  surface: Surface
  kind: Kind
  text: string
  file: string
  line: number
  component: string | null
}

const surfaces = (
  [
    ['dashboard', 'apps/dashboard/src', 'apps/dashboard/tsconfig.app.json'],
    ['cli', 'packages/cli/src', 'packages/cli/tsconfig.json'],
    ['api', 'apps/dispatch/src', 'apps/dispatch/tsconfig.json'],
  ] as const
).map(([surface, root, config]) => ({
  surface,
  root,
  config,
}))

const skipped = [
  /\.test\.tsx?$/,
  /(^|\/)test\//,
  /\.gen\.ts$/,
  /\.d\.ts$/,
  /cli\/src\/agent\/briefing\.ts$/,
]

const hole = '{…}'

const entities: Record<string, string> = {
  apos: "'",
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
}

const tidy = (text: string) =>
  text
    .replace(/&(\w+);/g, (match, name: string) =>
      Object.hasOwn(entities, name) ? entities[name]! : match,
    )
    .replace(/\s+/g, ' ')
    .trim()

const classNames = /(^| )(dark:)?(text|bg|border)-[a-z]+(-\d+)?(\/\d+)?( |$)/

const worthy = (text: string) => /\p{L}/u.test(text.replaceAll(hole, '')) && !classNames.test(text)

export const words = (text: string) => text.split(' ').filter((word) => /\p{L}/u.test(word)).length

type Piece = { text: string; at: Node }

const joinedText = (pieces: Piece[]) => pieces[0]?.text ?? hole

const parts = (node: Node | undefined): Piece[] => {
  if (!node) {
    return []
  }

  if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node)) {
    return parts(node.expression)
  }

  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return [
      {
        text: node.text,
        at: node,
      },
    ]
  }

  if (isTemplateExpression(node)) {
    return [
      {
        text: node.head.text + node.templateSpans.map((span) => hole + span.literal.text).join(''),
        at: node,
      },
    ]
  }

  if (isConditionalExpression(node)) {
    return [...parts(node.whenTrue), ...parts(node.whenFalse)]
  }

  if (isArrowFunction(node) && node.body.kind !== SyntaxKind.Block) {
    return parts(node.body)
  }

  if (
    isCallExpression(node) &&
    isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'trim'
  ) {
    return parts(node.expression.expression)
  }

  if (isBinaryExpression(node)) {
    const operator = node.operatorToken.kind

    if (operator === SyntaxKind.PlusToken) {
      return [
        {
          text: joinedText(parts(node.left)) + joinedText(parts(node.right)),
          at: node,
        },
      ]
    }

    if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
      return [...parts(node.left), ...parts(node.right)]
    }

    if (operator === SyntaxKind.AmpersandAmpersandToken) {
      return parts(node.right)
    }
  }

  return []
}

const loose = (node: Node | undefined): Piece[] => {
  const own = parts(node)

  return own.length || !node || !isCallExpression(node) ? own : node.arguments.flatMap(loose)
}

const literal = (node: Node) =>
  isStringLiteral(node) ||
  isNoSubstitutionTemplateLiteral(node) ||
  isTemplateExpression(node) ||
  isTemplateSpan(node) ||
  (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken)

const insideDiagnostic = (node: Node) => {
  for (let at: Node | undefined = node.parent; at; at = at.parent) {
    if (
      isImportDeclaration(at) ||
      isLiteralTypeNode(at) ||
      ((isCallExpression(at) || isNewExpression(at)) &&
        /^(console\.\w+|Error|TypeError)$/.test(at.expression.getText()))
    ) {
      return true
    }
  }

  return false
}

const inline = /^(code|strong|b|em|i|kbd|span|a|Link|Code)$/

const nameOf = (node: Node | undefined) =>
  node && (isIdentifier(node) || isStringLiteral(node)) ? node.text : null

const calleeOf = (node: CallExpression | NewExpression) => {
  const callee = node.expression

  if (isIdentifier(callee)) {
    return {
      name: callee.text,
      member: false,
      full: callee.text,
    }
  }

  if (isPropertyAccessExpression(callee)) {
    return {
      name: callee.name.text,
      member: true,
      full: `${nameOf(callee.expression) ?? ''}.${callee.name.text}`,
    }
  }

  return {
    name: callee.kind === SyntaxKind.SuperKeyword ? 'super' : '',
    member: false,
    full: '',
  }
}

const componentOf = (node: Node): string | null => {
  for (let at: Node | undefined = node.parent; at; at = at.parent) {
    if ((isFunctionDeclaration(at) || isMethodDeclaration(at)) && at.name) {
      return nameOf(at.name)
    }

    if (
      isVariableDeclaration(at) &&
      at.initializer &&
      (isArrowFunction(at.initializer) || isFunctionExpression(at.initializer))
    ) {
      return nameOf(at.name)
    }
  }

  return null
}

const tagKind = (tag: string): Kind =>
  /^h[1-6]$|Title$|Heading$/.test(tag)
    ? 'heading'
    : /^(button|a)$|Button$|MenuItem$|Link$|Trigger$|^Tabs?Trigger/.test(tag)
      ? 'button'
      : /^(label|th|legend|dt)$|Label$|TableHead$/.test(tag)
        ? 'label'
        : /Badge$|Status$|Pill$/.test(tag)
          ? 'status'
          : tag.endsWith('Description')
            ? 'description'
            : /Tooltip/.test(tag)
              ? 'help'
              : 'body'

const keyKinds: Record<Kind, string> = {
  heading: 'title heading',
  button: '',
  label: 'label aria-label alt ask what prompt',
  body: 'message detail body empty reason children',
  placeholder: 'placeholder',
  status: 'wait started waiting',
  error: 'explanation error error_description failure failed',
  fix: 'fix',
  help: 'tooltip hint help',
  description: 'description summary',
  toast: 'success',
  other: '',
}

const keyKind = new Map(
  Object.entries(keyKinds).flatMap(([kind, keys]) =>
    keys ? keys.split(' ').map((key) => [key, kind as Kind] as const) : [],
  ),
)

const suffixKind = (key: string): Kind | null =>
  keyKind.get(key) ??
  (key.endsWith('Label')
    ? 'label'
    : key.endsWith('Title')
      ? 'heading'
      : key.endsWith('Placeholder')
        ? 'placeholder'
        : key.endsWith('Description')
          ? 'description'
          : /^error(Text|Message)$/.test(key)
            ? 'error'
            : /(Text|Message|Hint)$/.test(key)
              ? 'body'
              : null)

const propertyKeys: Record<Surface, string[]> = {
  dashboard:
    'title heading label placeholder description summary detail hint help message empty body error prompt tooltip fix started waiting success failure failed ask'.split(
      ' ',
    ),
  cli: 'label what wait message hint placeholder explanation fix description summary'.split(' '),
  api: 'summary description explanation fix message reason detail hint error_description'.split(
    ' ',
  ),
}

const mapNames: Record<Surface, RegExp> = {
  dashboard: /(Text|Label|Labels|Copy|Title|Titles)$/,
  cli: /(Text|Label|Labels)$/,
  api: /(Fix|Copy)$/,
}

const textFunctions = /(Text|Label|Title|Copy|Message|Summary)$/

type Spec = (Kind | null)[]

const cliCalls: Record<string, Spec> = {
  progress: ['status'],
  waiting: [null, 'status'],
  usage: ['error', 'fix'],
  notFound: ['error', 'fix'],
  envelopeOf: [null, 'error', 'fix'],
  ask: ['label'],
  askSecret: ['label'],
  confirm: ['label'],
  choose: ['label'],
}

const cliMembers: Record<string, Spec> = {
  description: ['description'],
  summary: ['description'],
  option: [null, 'help'],
  requiredOption: [null, 'help'],
  argument: [null, 'help'],
  addHelpText: [null, 'help'],
  helpOption: [null, 'help'],
}

const errorClass = (name: string) =>
  name.endsWith('Error') && !/^(Error|TypeError|RangeError|SyntaxError)$/.test(name)

const codeLike = (node: Node | undefined) =>
  !!node &&
  ((isStringLiteral(node) && /^[A-Z][A-Z_]+$/.test(node.text)) ||
    (isIdentifier(node) && node.text === 'code') ||
    (isPropertyAccessExpression(node) && node.name.text === 'code'))

const extract = (surface: Surface, file: string, source: SourceFile, out: Entry[]) => {
  const add = (kind: Kind, pieces: Piece[]) => {
    for (const { text: raw, at } of pieces) {
      const text = tidy(raw)

      if (worthy(text)) {
        const line = source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1

        out.push({
          surface,
          kind,
          text,
          file,
          line,
          component: componentOf(at),
        })
      }
    }
  }

  const sentences = (pieces: Piece[]) => pieces.filter((piece) => words(piece.text) > 1)

  const args = (node: CallExpression | NewExpression, spec: Spec, read = parts) => {
    for (const [index, kind] of spec.entries()) {
      add(kind ?? 'other', kind ? read(node.arguments?.[index]) : [])
    }
  }

  const mapValues = (node: Node, kind: Kind, nested = false) => {
    node.forEachChild((child) => {
      if (isPropertyAssignment(child) && isObjectLiteralExpression(child.initializer)) {
        mapValues(child.initializer, kind, true)
      } else if (
        isPropertyAssignment(child) &&
        (!nested || propertyKeys[surface].includes(nameOf(child.name) ?? ''))
      ) {
        add(kind, parts(child.initializer))
      }
    })
  }

  const returns = (node: Node) => {
    if (isReturnStatement(node)) {
      add('label', parts(node.expression))
    }

    if (!isArrowFunction(node) && !isFunctionExpression(node)) {
      node.forEachChild(returns)
    }
  }

  const jsxChildren = (node: Node, tag: string) => {
    const kind = tagKind(tag)
    let buffer = ''
    let start: Node | null = null
    const append = (at: Node, text: string) => {
      start ??= at
      buffer += text
    }
    const flush = () => {
      if (start) {
        add(kind, [
          {
            text: buffer,
            at: start,
          },
        ])
      }

      buffer = ''
      start = null
    }

    const children = isJsxElement(node) || isJsxFragment(node) ? node.children : []

    for (const child of children) {
      if (isJsxText(child)) {
        append(child, child.text)
      } else if (isJsxExpression(child)) {
        append(child, child.expression ? hole : '')
        add(kind, parts(child.expression))
      } else if (isJsxElement(child) && inline.test(child.openingElement.tagName.getText(source))) {
        append(child, hole)
      } else {
        flush()
      }
    }

    flush()
  }

  const visit = (node: Node) => {
    if (surface === 'dashboard' && (isJsxElement(node) || isJsxFragment(node))) {
      jsxChildren(node, isJsxElement(node) ? node.openingElement.tagName.getText(source) : '')
    }

    if (surface === 'dashboard' && isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(source)
      const element = node.parent.parent
      const tag =
        isJsxOpeningElement(element) || isJsxSelfClosingElement(element)
          ? element.tagName.getText(source)
          : ''
      const intrinsic = /^[a-z]/.test(tag)
      const kind = name === 'title' && intrinsic ? 'help' : suffixKind(name)

      if (kind) {
        const value = node.initializer

        add(kind, isJsxExpression(value) ? parts(value.expression) : parts(value))
      }
    }

    if (isVariableDeclaration(node) && node.initializer) {
      const name = nameOf(node.name) ?? ''
      let init: Node = node.initializer

      while (isAsExpression(init) || isSatisfiesExpression(init)) {
        init = init.expression
      }

      const stringRecord =
        surface === 'dashboard' && /^Record<.*, *string>$/s.test(node.type?.getText(source) ?? '')

      if ((mapNames[surface].test(name) || stringRecord) && isObjectLiteralExpression(init)) {
        mapValues(
          init,
          surface === 'api'
            ? 'fix'
            : /status|state|tone|live|closed|pending/i.test(name)
              ? 'status'
              : 'label',
        )
      }

      if (surface === 'dashboard' && textFunctions.test(name) && isArrowFunction(init)) {
        if (init.body.kind === SyntaxKind.Block) {
          returns(init.body)
        } else {
          add('label', parts(init.body))
        }
      }
    }

    if (isPropertyAssignment(node)) {
      const key = nameOf(node.name)

      if (key && propertyKeys[surface].includes(key)) {
        const kind = surface === 'api' && key === 'message' ? 'error' : (suffixKind(key) ?? 'other')
        const pieces = parts(node.initializer)

        add(kind, surface === 'dashboard' ? pieces : sentences(pieces))
      }
    }

    if (isCallExpression(node) || isNewExpression(node)) {
      const callee = calleeOf(node)
      const first = node.arguments?.[0]

      if (surface === 'dashboard') {
        if (/^toast(\.\w+)?$/.test(callee.full)) {
          args(node, ['toast'], loose)
        }

        if (callee.name === 'announce') {
          args(node, [null, 'toast'], loose)
        }

        if (callee.name === 'setError' || (isNewExpression(node) && callee.name === 'Error')) {
          args(node, ['error'], loose)
        }

        if (callee.full === 'window.confirm' || callee.full === 'confirm') {
          args(node, ['other'])
        }
      }

      if (surface === 'cli') {
        if (isNewExpression(node) && callee.name === 'Error') {
          args(node, ['error'])
        }

        if (isNewExpression(node) && (callee.name === 'Option' || callee.name === 'Argument')) {
          args(node, [null, 'help'])
        } else if (callee.member && Object.hasOwn(cliMembers, callee.name)) {
          args(node, cliMembers[callee.name]!)
        } else if (!callee.member && Object.hasOwn(cliCalls, callee.name)) {
          args(node, cliCalls[callee.name]!)
        }

        if (
          /^(process\.std(out|err)|console)\.\w+$/.test(callee.full) ||
          /^\.(write|log|error|warn)$/.test(callee.full)
        ) {
          const pieces = parts(first)

          add(pieces.some((piece) => piece.text.startsWith('error')) ? 'error' : 'body', pieces)
        }
      }

      if (surface === 'api') {
        const failing =
          callee.name === 'fail' ||
          callee.name === 'super' ||
          (isNewExpression(node) && errorClass(callee.name))

        if (failing && codeLike(first)) {
          args(node, [null, 'error', 'fix'])
        } else if (isNewExpression(node) && errorClass(callee.name)) {
          args(node, ['error'])
        }

        if (callee.name === 'issue') {
          args(node, [null, 'error'])
        }

        if (callee.name === 'page' && file.endsWith('auth/pages.ts')) {
          add('heading', parts(first))
          add(
            'body',
            parts(node.arguments?.[1]).map((piece) => ({
              ...piece,
              text: piece.text.replace(/<[^>]+>/g, ' '),
            })),
          )
        }
      }
    }

    if (isParameterDeclaration(node) && node.initializer && surface === 'dashboard') {
      const kind = suffixKind(nameOf(node.name) ?? '')

      if (kind) {
        add(kind, parts(node.initializer))
      }
    }

    if (
      surface === 'dashboard' &&
      isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      isStringLiteral(node.elements[0]!) &&
      /^\p{Lu}/u.test(node.elements[0].text)
    ) {
      add('label', parts(node.elements[0]))
    }

    if (surface !== 'api' && literal(node) && !literal(node.parent) && !insideDiagnostic(node)) {
      const pieces = sentences(parts(node))
      const loud = (text: string) => /^\p{Lu}/u.test(text)
      const quiet = (text: string) =>
        words(text) > 2 && /^\p{Ll}[\p{L}’']* /u.test(text) && !text.includes('--')

      add(
        'other',
        file.includes('/renderers/')
          ? pieces
          : pieces.filter((piece) => loud(piece.text) || (surface === 'cli' && quiet(piece.text))),
      )
    }

    node.forEachChild(visit)
  }

  visit(source)
}

const vocabulary = (path: string) => {
  const terms: { term: string; meaning: string; section: string }[] = []
  let section = ''
  const lines = readFileSync(path, 'utf8').split('\n')

  lines.forEach((line, index) => {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
    }

    const separator = (text = '') => /^\|[-| ]+\|$/.test(text)

    if (/^\|.*\|$/.test(line) && !separator(line) && !separator(lines[index + 1])) {
      const [term = '', meaning = ''] = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', ''))

      terms.push({
        term,
        meaning,
        section,
      })
    }
  })

  return terms
}

const watched = [
  ...'key keys variable variables sealed plain secret visible environment production preview live workspace'.split(
    ' ',
  ),
  ...'machine sandbox station server task session app service deploy deployment ship approval agent'.split(
    ' ',
  ),
  ...'drift injection broken serving'.split(' '),
  'environment variable',
  'other side',
  'stable address',
  'also with',
]

const findingsOf = (strings: Entry[]) => {
  const where = (entry: Entry) => `${entry.file}:${entry.line}`
  const groups = new Map<string, Map<string, Entry[]>>()

  for (const entry of strings) {
    const normalized = entry.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}{}… ]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
    const group = groups.get(normalized) ?? new Map<string, Entry[]>()

    group.set(entry.text, [...(group.get(entry.text) ?? []), entry])
    groups.set(normalized, group)
  }

  const terms = Object.fromEntries(
    watched.map((term) => {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${term}(?![\\p{L}\\p{N}])`, 'giu')
      const counts: Record<string, number> = {
        dashboard: 0,
        cli: 0,
        api: 0,
        total: 0,
      }

      for (const entry of strings) {
        const hits = entry.text.match(pattern)?.length ?? 0

        counts[entry.surface]! += hits
        counts.total! += hits
      }

      return [term, counts]
    }),
  )

  return {
    duplicates_with_variants: [...groups]
      .filter(([, variants]) => variants.size > 1)
      .map(([normalized, variants]) => ({
        normalized,
        variants: [...variants].map(([text, entries]) => ({
          text,
          count: entries.length,
          where: entries.slice(0, 5).map(where),
        })),
      })),
    terms,
    em_dash_or_dot_separators: strings
      .filter((e) => e.text.includes('—') || e.text.includes(' · '))
      .map((e) => ({
        surface: e.surface,
        text: e.text,
        where: where(e),
      })),
    long_helper_text: strings
      .filter((e) => ['body', 'description', 'other'].includes(e.kind) && words(e.text) > 12)
      .map((e) => ({
        surface: e.surface,
        words: words(e.text),
        text: e.text,
        where: where(e),
      })),
  }
}

export const collectStrings = (wanted: readonly Surface[] = surfaces.map((s) => s.surface)) => {
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  ).split('\0')
  const api = new API({
    cwd: process.cwd(),
  })
  const collected: Entry[] = []
  const unparsed: string[] = []

  try {
    const chosen = surfaces.filter((s) => wanted.includes(s.surface))
    const snapshot = api.updateSnapshot({
      openProjects: chosen.map((s) => resolve(s.config)),
    })

    for (const { surface, root, config } of chosen) {
      const program = snapshot.getProject(resolve(config))!.program

      for (const file of tracked.filter(
        (f) => f.startsWith(`${root}/`) && /\.tsx?$/.test(f) && !skipped.some((p) => p.test(f)),
      )) {
        const source = program.getSourceFile(resolve(file))

        if (source) {
          extract(surface, file, source, collected)
        } else {
          unparsed.push(file)
        }
      }
    }
  } finally {
    api.close()
  }

  const seen = new Set<string>()
  const strings = collected.filter((entry) => {
    const id = `${entry.file}:${entry.line}:${entry.text}`

    return !seen.has(id) && !!seen.add(id)
  })

  return {
    strings,
    unparsed,
  }
}

const writeCatalogue = (target: string | undefined) => {
  const { strings, unparsed } = collectStrings()
  const counts = Object.fromEntries(
    surfaces.map(({ surface }) => {
      const mine = strings.filter((e) => e.surface === surface)
      const kinds: Record<string, number> = {}

      for (const entry of mine) {
        kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
      }

      return [
        surface,
        {
          total: mine.length,
          kinds,
        },
      ]
    }),
  )

  const catalogue = {
    generated_at: new Date().toISOString(),
    counts,
    unparsed,
    vocabulary: vocabulary('docs/01-vocabulary.md'),
    strings,
    findings: findingsOf(strings),
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        counts,
        unparsed,
        vocabulary: catalogue.vocabulary.length,
      },
      null,
      2,
    )}\n`,
  )

  if (target) {
    mkdirSync(dirname(resolve(target)), {
      recursive: true,
    })
    writeFileSync(target, `${JSON.stringify(catalogue, null, 2)}\n`)
    process.stdout.write(`wrote ${target}\n`)
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  writeCatalogue(process.argv[2])
}
