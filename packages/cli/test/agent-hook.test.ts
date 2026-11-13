import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const image = new URL('../../../images/sandbox-toolchain/', import.meta.url).pathname
const hook = join(image, 'sandbox-agent-hook')

let home: string
let bin: string

const relayTools = spawnSync('sh', ['-c', 'command -v flock && command -v setsid']).status === 0

const needsRelayTools = {
  skip: relayTools ? false : 'needs flock and setsid from util-linux, as in the toolchain image',
}

const spool = () => join(home, '.local', 'state', 'stationly', 'spool')

const spoolFiles = () =>
  existsSync(spool())
    ? readdirSync(spool())
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hook-home-'))
  bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'sly'), '#!/bin/sh\necho "$@" >>"$HOME/relay.log"\nsleep 2\n')
  chmodSync(join(bin, 'sly'), 0o755)
})

afterEach(() => {
  rmSync(home, {
    recursive: true,
    force: true,
  })
})

const fire = (input: string, token: string | null = 'sly_token') =>
  spawnSync('/bin/sh', [hook], {
    input,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      ...(token
        ? {
            STATIONLY_TOKEN: token,
          }
        : {}),
    },
  })

const relayStarts = () =>
  existsSync(join(home, 'relay.log'))
    ? readFileSync(join(home, 'relay.log'), 'utf8').trim().split('\n').length
    : 0

const waitForRelay = async () => {
  for (let waited = 0; waited < 3000 && relayStarts() === 0; waited += 20) {
    await sleep(20)
  }
}

test('without STATIONLY_TOKEN the hook exits 0 and touches nothing', async () => {
  const result = fire('{"hook_event_name":"Stop"}', null)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(existsSync(join(home, '.local')), false)
  await sleep(100)
  assert.equal(relayStarts(), 0)
})

test(
  'with a token the hook spools its input under a nanosecond name, prints nothing and starts the relay',
  needsRelayTools,
  async () => {
    const payload = '{"hook_event_name":"Stop","last_assistant_message":"line\\nbreak"}'
    const result = fire(payload)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')

    const [name] = spoolFiles()

    assert.match(name!, /^\d{19}-\d+\.json$/)
    assert.equal(readFileSync(join(spool(), name!), 'utf8'), payload)
    assert.deepEqual(
      readdirSync(spool()).filter((entry) => entry.startsWith('.') && entry !== '.lock'),
      [],
    )
    await waitForRelay()
    assert.equal(readFileSync(join(home, 'relay.log'), 'utf8').trim(), 'agent relay')
  },
)

test('spool names sort in the order the hooks ran', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    fire(`{"n":${n}}`)
  }

  assert.deepEqual(
    spoolFiles().map((name) => JSON.parse(readFileSync(join(spool(), name), 'utf8')).n),
    [1, 2, 3, 4, 5],
  )
})

test('a second hook does not start a relay while one holds the lock', needsRelayTools, async () => {
  fire('{"n":1}')
  await waitForRelay()
  fire('{"n":2}')
  await sleep(300)

  assert.equal(relayStarts(), 1)
  assert.equal(spoolFiles().length, 2)
})

test(
  'a file spooled while the relay exits is relayed by another relay run',
  needsRelayTools,
  async () => {
    writeFileSync(
      join(bin, 'sly'),
      [
        '#!/bin/sh',
        'echo "$@" >>"$HOME/relay.log"',
        'dir="$HOME/.local/state/stationly/spool"',
        'if [ "$(wc -l <"$HOME/relay.log")" -eq 1 ]; then',
        '\tsleep 0.3',
        '\tprintf "{}" >"$dir/9999999999999999999-1.json"',
        'else',
        '\trm -f "$dir"/*.json',
        'fi',
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'sly'), 0o755)
    fire('{"n":1}')

    for (let waited = 0; waited < 4000 && spoolFiles().length > 0; waited += 20) {
      await sleep(20)
    }

    assert.equal(relayStarts(), 2)
    assert.deepEqual(spoolFiles(), [])
  },
)

test('the hook returns quickly enough not to hold the terminal', () => {
  const durations = Array.from(
    {
      length: 21,
    },
    () => {
      const start = performance.now()

      fire('{"hook_event_name":"MessageDisplay"}')

      return performance.now() - start
    },
  ).sort((a, b) => a - b)

  assert.ok(durations[10]! < 400)
})

const settings = JSON.parse(readFileSync(join(image, 'claude-managed-settings.json'), 'utf8')) as {
  hooks: Record<
    string,
    {
      matcher?: string
      hooks: { type: string; command: string; timeout: number }[]
    }[]
  >
}

test('the managed settings file hooks exactly the specced events', () => {
  assert.deepEqual(Object.keys(settings.hooks).sort(), [
    'Elicitation',
    'MessageDisplay',
    'Notification',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'PreToolUse',
    'SessionEnd',
    'SessionStart',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'UserPromptSubmit',
  ])
})

test('every entry runs the script synchronously with a 5 second timeout, so the spool follows the order of the events', () => {
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      assert.equal(group.hooks.length, 1)
      assert.deepEqual(group.hooks[0], {
        type: 'command',
        command: '/usr/local/bin/sandbox-agent-hook',
        timeout: 5,
      })
    }
  }
})

test('Notification has one entry per subscribed type and no other event has a matcher', () => {
  assert.deepEqual(
    settings.hooks.Notification!.map((group) => group.matcher),
    ['permission_prompt', 'elicitation_dialog', 'agent_needs_input'],
  )

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (event !== 'Notification') {
      assert.deepEqual(
        groups.map((group) => group.matcher),
        [undefined],
      )
    }
  }
})

test('the Dockerfile copies the script and the settings file into place', () => {
  const dockerfile = readFileSync(join(image, 'Dockerfile'), 'utf8')

  assert.ok(
    dockerfile.includes('COPY --chmod=0755 sandbox-agent-hook /usr/local/bin/sandbox-agent-hook\n'),
  )
  assert.ok(
    dockerfile.includes(
      'COPY --chmod=0644 claude-managed-settings.json /etc/claude-code/managed-settings.d/stationly.json\n',
    ),
  )
})
