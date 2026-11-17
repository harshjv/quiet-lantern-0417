import type { Static } from '@sinclair/typebox'

import { bytesText, gibibyte } from './format.ts'
import type { HostProbe, MachineRuntimeAdvice, machineRuntimeValues } from './model.ts'

type InstalledRuntime = (typeof machineRuntimeValues)[number]

export const machineRuntimeKindValues = ['gvisor', 'microvm'] as const

export type MachineRuntimeKind = (typeof machineRuntimeKindValues)[number]

export const microVmMemoryToSpare = 32 * gibibyte

export const machineRuntimeTradeoffs: Record<
  MachineRuntimeKind,
  { label: string; pros: string[]; cons: string[] }
> = {
  gvisor: {
    label: 'gVisor',
    pros: [
      'Runs on any Linux host, with or without KVM',
      'Starts in under a second and uses little memory, so more machines fit on a host',
      'A kernel in user space stands between each machine and the host kernel',
    ],
    cons: [
      'Some system calls and kernel features are missing, so a few programs fail',
      'Builds, databases and other work heavy on system calls run slower',
    ],
  },
  microvm: {
    label: 'Micro-VM',
    pros: [
      'Hardware virtualization separates each machine from the host',
      'Full Linux compatibility, with native Docker and databases',
      'Close to native speed for work heavy on system calls',
    ],
    cons: [
      'Needs KVM, which most cloud VMs do not offer',
      'Each machine boots its own kernel and holds its memory, so fewer fit on a host',
      'Runs slower nested inside another virtual machine',
    ],
  },
}

type Host = Static<typeof HostProbe>

export type MachineRuntimeAdviceDoc = Static<typeof MachineRuntimeAdvice>

const option = (
  runtime: MachineRuntimeKind,
  offered: readonly InstalledRuntime[],
  recommended: MachineRuntimeKind,
) => ({
  runtime,
  installed: (offered as readonly string[]).includes(runtime),
  recommended: runtime === recommended,
  pros: machineRuntimeTradeoffs[runtime].pros,
  cons: machineRuntimeTradeoffs[runtime].cons,
})

const noKvmReason = (host: Host) => {
  if (host.kvm_present) {
    return '/dev/kvm exists but cannot be opened, so machines run on gVisor'
  }

  if (host.hypervisor) {
    return `This host is a ${host.hypervisor} virtual machine without nested virtualization, so machines run on gVisor`
  }

  return 'No KVM on this host, so machines run on gVisor'
}

const kvmPreference = (host: Host): { runtime: MachineRuntimeKind; reason: string } => {
  if (host.hypervisor) {
    return {
      runtime: 'gvisor',
      reason: `This host is itself a ${host.hypervisor} virtual machine, so micro-VMs would run nested and slow`,
    }
  }

  if (host.memory_bytes < microVmMemoryToSpare) {
    return {
      runtime: 'gvisor',
      reason: `This host has ${bytesText(host.memory_bytes)} of memory, and gVisor fits more machines into it`,
    }
  }

  return {
    runtime: 'microvm',
    reason: `This host is bare metal with KVM and ${bytesText(host.memory_bytes)} of memory, which suits micro-VMs`,
  }
}

export const adviseMachineRuntime = (
  host: Host,
  offered: readonly InstalledRuntime[],
): MachineRuntimeAdviceDoc | null => {
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
  const options = machineRuntimeKindValues.map((runtime) =>
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
      `${machineRuntimeTradeoffs[preference.runtime].label} machines are not installed in this release, so machines run on ${machineRuntimeTradeoffs[offered[0]!].label}`,
    ],
    options,
  }
}

export const machineRuntimeChoice = (advice: MachineRuntimeAdviceDoc) =>
  advice.options.filter((o) => o.installed).length > 1
