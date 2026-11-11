import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isMac,
  keySteps,
  places,
  shortcutGroups,
  shortcutKeys,
  shortcuts,
  spokenShortcut,
  type ShortcutId,
} from '../src/lib/shortcuts.ts'

const ids = Object.keys(shortcuts) as ShortcutId[]

test('every shortcut shows up once in the help groups', () => {
  const grouped = shortcutGroups().flatMap((group) => group.ids)

  assert.deepEqual([...grouped].sort(), [...ids].sort())
  assert.deepEqual(
    shortcutGroups().map((group) => group.place),
    [...places],
  )
})

test('no two shortcuts share a key', () => {
  const keys = ids.flatMap((id) => shortcuts[id].keys)

  assert.equal(new Set(keys).size, keys.length)
})

test('keys are lower case so the hotkey parser matches them', () => {
  for (const id of ids) {
    for (const key of shortcuts[id].keys) {
      assert.equal(key, key.toLowerCase(), `${id}: ${key}`)
    }
  }
})

test('only the palette fires while typing in a field', () => {
  assert.deepEqual(
    ids.filter((id) => 'inFields' in shortcuts[id]),
    ['palette'],
  )
})

test('the modifier follows the platform', () => {
  assert.deepEqual(shortcutKeys('palette', true), [
    [
      {
        text: '⌘',
        name: 'Command',
      },
      {
        text: 'K',
        name: 'K',
      },
    ],
  ])
  assert.deepEqual(
    shortcutKeys('palette', false)[0].map((key) => key.text),
    ['Ctrl', 'K'],
  )
  assert.equal(spokenShortcut('palette', false), 'Control K')
})

test('sequences read as steps and ranges collapse into one key', () => {
  assert.deepEqual(
    keySteps('g>p', false).map((step) => step.map((key) => key.text)),
    [['G'], ['P']],
  )
  assert.equal(spokenShortcut('projects', true), 'G then P')
  assert.deepEqual(
    shortcutKeys('tab', true).map((keys) => keys.map((key) => key.text)),
    [['G'], ['1–6']],
  )
  assert.equal(spokenShortcut('tab', true), 'G then 1 to 6')
})

test('question mark and slash show the characters people type', () => {
  assert.equal(shortcutKeys('help', true)[0][0].text, '?')
  assert.equal(shortcutKeys('filter', false)[0][0].text, '/')
})

test('mac detection matches desktop Safari but not iPhone', () => {
  assert.equal(isMac('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true)
  assert.equal(isMac('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false)
  assert.equal(isMac('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false)
})
