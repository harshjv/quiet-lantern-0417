import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adviseMachineRuntime, gibibyte, machineRuntimeChoice } from '../src/index.ts'

const host = {
  kvm_present: true,
  kvm_usable: true,
  cpu_virtualization: 'vmx' as const,
  hypervisor: null,
  cpu_cores: 32,
  memory_bytes: 128 * gibibyte,
  sandbox_free_bytes: 500 * gibibyte,
}

const cases = [
  {
    name: 'a cloud VM without KVM runs gVisor and offers nothing to choose',
    host: {
      ...host,
      kvm_present: false,
      kvm_usable: false,
      cpu_virtualization: null,
      hypervisor: 'kvm',
    },
    reason:
      'This host is a kvm virtual machine without nested virtualization, so machines run on gVisor',
    options: ['gvisor'],
    recommended: 'gvisor',
  },
  {
    name: 'bare metal without KVM says so in one line',
    host: {
      ...host,
      kvm_present: false,
      kvm_usable: false,
    },
    reason: 'No KVM on this host, so machines run on gVisor',
    options: ['gvisor'],
    recommended: 'gvisor',
  },
  {
    name: 'a /dev/kvm that cannot be opened counts as no KVM',
    host: {
      ...host,
      kvm_usable: false,
    },
    reason: '/dev/kvm exists but cannot be opened, so machines run on gVisor',
    options: ['gvisor'],
    recommended: 'gvisor',
  },
  {
    name: 'nested virtualization recommends gVisor',
    host: {
      ...host,
      hypervisor: 'kvm',
    },
    reason: 'This host is itself a kvm virtual machine, so micro-VMs would run nested and slow',
    options: ['gvisor', 'microvm'],
    recommended: 'gvisor',
  },
  {
    name: 'little memory recommends gVisor',
    host: {
      ...host,
      memory_bytes: 16 * gibibyte,
    },
    reason: 'This host has 16 GiB of memory, and gVisor fits more machines into it',
    options: ['gvisor', 'microvm'],
    recommended: 'gvisor',
  },
  {
    name: 'bare metal with KVM and memory to spare recommends micro-VMs',
    host,
    reason: 'This host is bare metal with KVM and 128 GiB of memory, which suits micro-VMs',
    options: ['gvisor', 'microvm'],
    recommended: 'microvm',
  },
]

for (const c of cases) {
  test(`adviseMachineRuntime: ${c.name}`, () => {
    const advice = adviseMachineRuntime(c.host, ['gvisor'])!

    assert.equal(advice.default, 'gvisor')
    assert.equal(advice.reasons[0], c.reason)
    assert.deepEqual(
      advice.options.map((option) => option.runtime),
      c.options,
    )
    assert.deepEqual(
      advice.options.filter((option) => option.recommended).map((option) => option.runtime),
      [c.recommended],
    )
    assert.equal(machineRuntimeChoice(advice), false)
  })
}

test('adviseMachineRuntime marks micro-VMs as not installed and falls back to gVisor', () => {
  const advice = adviseMachineRuntime(host, ['gvisor'])!
  const microvm = advice.options.find((option) => option.runtime === 'microvm')!

  assert.equal(microvm.installed, false)
  assert.equal(microvm.recommended, true)
  assert.ok(microvm.pros.length > 0 && microvm.cons.length > 0)
  assert.equal(
    advice.reasons[1],
    'Micro-VM machines are not installed in this release, so machines run on gVisor',
  )
})

test('adviseMachineRuntime has no advice for a station without machines', () => {
  assert.equal(adviseMachineRuntime(host, []), null)
})
