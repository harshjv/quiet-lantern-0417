import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { renderMarkdown, safeUrl } from '../src/lib/markdown.ts'

const html = (text: string) => renderToStaticMarkup(renderMarkdown(text))

test('only http, https and mailto links survive', () => {
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeUrl('http://example.com'), 'http://example.com')
  assert.equal(safeUrl('mailto:a@example.com'), 'mailto:a@example.com')
  assert.equal(safeUrl('javascript:alert(1)'), '')
  assert.equal(safeUrl('data:text/html,<script>1</script>'), '')
  assert.equal(safeUrl('/relative'), '')
  assert.equal(safeUrl('//evil.example'), '')
})

test('a link is shown with its target and opens safely', () => {
  const out = html('[docs](https://example.com/x)')

  assert.match(out, /<a href="https:\/\/example.com\/x"/)
  assert.match(out, /rel="noreferrer noopener nofollow"/)
  assert.match(out, /\(https:\/\/example.com\/x\)/)
})

test('a bare link is not repeated', () => {
  const out = html('<https://example.com>')

  assert.equal(out.split('https://example.com').length - 1, 2)
})

test('a script link renders as plain text', () => {
  const out = html('[click](javascript:alert(1))')

  assert.doesNotMatch(out, /href=/)
  assert.match(out, /click/)
})

test('raw HTML is dropped', () => {
  const out = html(
    'hi <script>alert(1)</script><img src="https://evil.example/x.png" onerror="x()"> <b>bold</b>',
  )

  assert.doesNotMatch(out, /<script/)
  assert.doesNotMatch(out, /<img/)
  assert.doesNotMatch(out, /<b>/)
  assert.doesNotMatch(out, /onerror/)
})

test('a markdown image becomes a link, never a remote image', () => {
  const out = html('![chart](https://evil.example/pixel.png)')

  assert.doesNotMatch(out, /<img/)
  assert.match(out, /<a href="https:\/\/evil.example\/pixel.png"/)
  assert.match(out, />chart</)
})

test('a data image is dropped', () => {
  const out = html('![x](data:image/png;base64,AAAA)')

  assert.doesNotMatch(out, /<img|href=|data:/)
})
