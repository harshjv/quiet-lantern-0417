import { Cpu, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { machineRuntimeChoice } from '@stationly/protocol/sandbox-runtime'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith } from '@/components/code'
import { FormError } from '@/components/form-dialog'
import { KeyValue } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, idempotency, send, type HostProbe, type Station } from '@/lib/api'
import { commands } from '@/lib/commands'
import { bytes } from '@/lib/format'
import { cpuVirtualization, taskRuntime } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { Section } from '@/workbench/parts'

type Advice = NonNullable<Station['machine_runtime_advice']>
type Option = Advice['options'][number]
type Runtime = Advice['default']

const kvmText = (host: HostProbe) => {
  if (host.kvm_usable) {
    return 'Usable'
  }

  if (host.kvm_present) {
    return '/dev/kvm exists but cannot be opened'
  }

  return 'Not available'
}

const hostText = (host: HostProbe) => {
  if (host.hypervisor === null) {
    return 'Bare metal'
  }

  if (host.hypervisor === 'unknown') {
    return 'Unknown'
  }

  return `Virtualized (${host.hypervisor})`
}

const cpuText = (host: HostProbe, arch: Station['arch']) => {
  if (host.cpu_virtualization) {
    return cpuVirtualization[host.cpu_virtualization]
  }

  return arch === 'arm64' ? 'Not reported on arm64' : 'None'
}

function HostFacts({ host, arch }: { host: HostProbe; arch: Station['arch'] }) {
  return (
    <KeyValue
      framed
      items={[
        ['KVM', kvmText(host)],
        ['CPU virtualization', cpuText(host, arch)],
        ['Host', hostText(host)],
        ['CPU cores', String(host.cpu_cores)],
        ['Memory (RAM)', bytes(host.memory_bytes)],
        [
          'Disk free for tasks',
          host.sandbox_free_bytes === null ? 'No task filesystem' : bytes(host.sandbox_free_bytes),
        ],
      ]}
    />
  )
}

function OptionCard({ option, inUse }: { option: Option; inUse: boolean }) {
  return (
    <li className="space-y-3 border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{taskRuntime[option.runtime]}</span>
        {inUse && <Badge>In use</Badge>}
        {option.recommended && <Badge variant="outline">Recommended for this host</Badge>}
        {!option.installed && <Badge variant="secondary">Not installed in this release</Badge>}
      </div>
      <ul className="space-y-1 text-sm">
        {option.pros.map((pro) => (
          <li key={pro}>
            <span className="sr-only">Pro: </span>
            <span aria-hidden className="text-muted-foreground">
              +{' '}
            </span>
            {pro}
          </li>
        ))}
        {option.cons.map((con) => (
          <li key={con}>
            <span className="sr-only">Con: </span>
            <span aria-hidden className="text-muted-foreground">
              −{' '}
            </span>
            {con}
          </li>
        ))}
      </ul>
    </li>
  )
}

function RuntimeChoice({
  station,
  advice,
  current,
}: {
  station: Pick<Station, 'id' | 'name'>
  advice: Advice
  current: Runtime
}) {
  const [value, setValue] = useState<Runtime>(current)
  const mutation = useApiMutation({
    mutationFn: (runtime: Runtime) =>
      send(
        api.v1
          .servers({
            server: station.id,
          })
          .patch(
            {
              default_machine_runtime: runtime,
            },
            idempotency(),
          ),
      ),
    invalidate: ['stations'],
    waiting: (runtime) => `Default task runtime ${taskRuntime[runtime]} on ${station.name}`,
    success: (_body, runtime) => ({
      title: `New tasks on ${station.name} start on ${taskRuntime[runtime]}`,
      description: 'Running tasks keep the runtime they started with.',
    }),
  })
  const installed = advice.options.filter((option) => option.installed)

  return (
    <form
      className="max-w-xl space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate(value)
      }}
    >
      <FormError>{mutation.errorText}</FormError>
      <ChoiceCards
        name={`task-runtime-${station.id}`}
        legend="Default runtime for new tasks"
        value={value}
        onChange={setValue}
        options={installed.map((option) => ({
          value: option.runtime as Runtime,
          title: taskRuntime[option.runtime],
          hint: option.recommended ? 'Recommended for this host' : 'Available on this host',
        }))}
      />
      <Button type="submit" size="sm" disabled={mutation.isPending || value === current}>
        {mutation.isPending && <Loader2 className="animate-spin" />}
        Save default runtime
      </Button>
    </form>
  )
}

export function TaskRuntimeSection({ station }: { station: Station }) {
  const host = station.capabilities?.host
  const advice = station.machine_runtime_advice

  if (!host) {
    return (
      <Section icon={Cpu} title="Task runtime">
        <p className="text-sm text-muted-foreground">Hardware not reported yet</p>
      </Section>
    )
  }

  if (!advice) {
    return (
      <Section icon={Cpu} title="Task runtime">
        <HostFacts host={host} arch={station.arch ?? null} />
      </Section>
    )
  }

  const current = station.default_machine_runtime ?? advice.default

  return (
    <Section icon={Cpu} title="Task runtime">
      <HostFacts host={host} arch={station.arch ?? null} />
      <ul className="grid gap-3 md:grid-cols-2">
        {advice.options.map((option) => (
          <OptionCard key={option.runtime} option={option} inUse={option.runtime === current} />
        ))}
      </ul>
      {machineRuntimeChoice(advice) && (
        <>
          <RuntimeChoice station={station} advice={advice} current={current} />
          <AlsoWith cli={commands.setMachineRuntime(station.name)} tool="update_server" />
        </>
      )}
    </Section>
  )
}
