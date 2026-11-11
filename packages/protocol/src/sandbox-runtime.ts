import type { Static } from '@sinclair/typebox'

import { bytesText, gibibyte } from './format.ts'
import type { HostProbe, SandboxRuntimeAdvice, sandboxRuntimeValues } from './model.ts'

type InstalledRuntime = (typeof sandboxRuntimeValues)[number]

export const sandboxRuntimeKindValues = ['gvisor', 'microvm'] as const

export type SandboxRuntimeKind = (typeof sandboxRuntimeKindValues)[number]

export const microVmMemoryToSpare = 32 * gibibyte

export const sandboxRuntimeTradeoffs: Record<
  SandboxRuntimeKind,
  { label: string; pros: string[]; cons: string[] }
> = {
  gvisor: {
    label: 'gVisor',
    pros: [
      'Runs on any Linux host, with or without KVM',
      'Starts in under a second and uses little memory, so more sandboxes fit on a host',
      'A kernel in user space stands between each sandbox and the host kernel',
    ],
    cons: [
      'Some system calls and kernel features are missing, so a few programs fail',
      'Builds, databases and other work heavy on system calls run slower',
    ],
  },
  microvm: {
    label: 'Micro-VM',
    pros: [
      'Hardware virtualization separates each sandbox from the host',
      'Full Linux compatibility, with native Docker and databases',
      'Close to native speed for work heavy on system calls',
    ],
    cons: [
      'Needs KVM, which most cloud VMs do not offer',
      'Each sandbox boots its own kernel and holds its memory, so fewer fit on a host',
      'Runs slower nested inside another virtual machine',
    ],
  },
}

type Host = Static<typeof HostProbe>

export type SandboxRuntimeAdviceDoc = Static<typeof SandboxRuntimeAdvice>

const option = (
  runtime: SandboxRuntimeKind,
  offered: readonly InstalledRuntime[],
  recommended: SandboxRuntimeKind,
) => ({
  runtime,
  installed: (offered as readonly string[]).includes(runtime),
  recommended: runtime === recommended,
  pros: sandboxRuntimeTradeoffs[runtime].pros,
  cons: sandboxRuntimeTradeoffs[runtime].cons,
})

const noKvmReason = (host: Host) => {
  if (host.kvm_present) {
    return '/dev/kvm exists but cannot be opened, so sandboxes run on gVisor'
  }

  if (host.hypervisor) {
    return `This host is a ${host.hypervisor} virtual machine without nested virtualization, so sandboxes run on gVisor`
  }

  return 'No KVM on this host, so sandboxes run on gVisor'
}

const kvmPreference = (host: Host): { runtime: SandboxRuntimeKind; reason: string } => {
  if (host.hypervisor) {
    return {
      runtime: 'gvisor',
      reason: `This host is itself a ${host.hypervisor} virtual machine, so micro-VMs would run nested and slow`,
    }
  }

  if (host.memory_bytes < microVmMemoryToSpare) {
    return {
      runtime: 'gvisor',
      reason: `This host has ${bytesText(host.memory_bytes)} of memory, and gVisor fits more sandboxes into it`,
    }
  }

  return {
    runtime: 'microvm',
    reason: `This host is bare metal with KVM and ${bytesText(host.memory_bytes)} of memory, which suits micro-VMs`,
  }
}

export const adviseSandboxRuntime = (
  host: Host,
  offered: readonly InstalledRuntime[],
): SandboxRuntimeAdviceDoc | null => {
  if (!offered.length) {
    return null
  }

  if (!host.kvm_usable) {
    return {
      default: offered[0]!,
      reasons: [noKvmReason(host)],
      options: [option('gvisor', offered, 'gvisor')],
    }
  }

  const preference = kvmPreference(host)
  const options = sandboxRuntimeKindValues.map((runtime) =>
    option(runtime, offered, preference.runtime),
  )
  const chosen = options.find((o) => o.recommended && o.installed)

  if (chosen) {
    return {
      default: chosen.runtime as InstalledRuntime,
      reasons: [preference.reason],
      options,
    }
  }

  return {
    default: offered[0]!,
    reasons: [
      preference.reason,
      `${sandboxRuntimeTradeoffs[preference.runtime].label} sandboxes are not installed in this release, so sandboxes run on ${sandboxRuntimeTradeoffs[offered[0]!].label}`,
    ],
    options,
  }
}

export const sandboxRuntimeChoice = (advice: SandboxRuntimeAdviceDoc) =>
  advice.options.filter((o) => o.installed).length > 1
