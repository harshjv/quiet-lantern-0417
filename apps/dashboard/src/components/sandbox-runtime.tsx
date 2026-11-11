import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { sandboxRuntimeChoice } from '@stationly/protocol/sandbox-runtime'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith } from '@/components/code'
import { FormError } from '@/components/form-dialog'
import { KeyValue, Subsection } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, idempotency, send, type HostProbe, type Station } from '@/lib/api'
import { commands } from '@/lib/commands'
import { bytes } from '@/lib/format'
import { cpuVirtualization, sandboxRuntime } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'

type Advice = NonNullable<Station['sandbox_runtime_advice']>
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

  return `Virtual machine (${host.hypervisor})`
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
        ['Memory', bytes(host.memory_bytes)],
        [
          'Free for sandboxes',
          host.sandbox_free_bytes === null
            ? 'No sandbox filesystem'
            : bytes(host.sandbox_free_bytes),
        ],
      ]}
    />
  )
}

function OptionCard({ option, inUse }: { option: Option; inUse: boolean }) {
  return (
    <li className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{sandboxRuntime[option.runtime]}</span>
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
          .stations({
            station: station.id,
          })
          .patch(
            {
              default_sandbox_runtime: runtime,
            },
            idempotency(),
          ),
      ),
    invalidate: ['stations'],
    staged: (runtime) => `Default sandbox runtime ${sandboxRuntime[runtime]} on ${station.name}`,
    success: (_body, runtime) => ({
      title: `New sandboxes on ${station.name} start on ${sandboxRuntime[runtime]}`,
      description: 'Sandboxes that exist keep the runtime they started with.',
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
        name={`sandbox-runtime-${station.id}`}
        legend="Default runtime for new sandboxes"
        value={value}
        onChange={setValue}
        options={installed.map((option) => ({
          value: option.runtime as Runtime,
          title: sandboxRuntime[option.runtime],
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

export function SandboxRuntimeSection({ station }: { station: Station }) {
  const host = station.capabilities?.host
  const advice = station.sandbox_runtime_advice

  if (!host) {
    return (
      <Subsection title="Sandbox runtime">
        <p className="text-sm text-muted-foreground">
          This station has not reported its hardware yet. It does once stationd connects.
        </p>
      </Subsection>
    )
  }

  if (!advice) {
    return (
      <Subsection
        title="Sandbox runtime"
        description="This station runs no sandboxes, so there is no runtime to choose."
      >
        <HostFacts host={host} arch={station.arch ?? null} />
      </Subsection>
    )
  }

  const chosen = station.default_sandbox_runtime
  const current = chosen ?? advice.default

  return (
    <Subsection
      title="Sandbox runtime"
      description={`New sandboxes start on ${sandboxRuntime[current]}, ${chosen ? 'chosen for this station' : 'the recommendation for this host'}.`}
    >
      <HostFacts host={host} arch={station.arch ?? null} />
      <div className="space-y-1 text-sm">
        {advice.reasons.map((reason) => (
          <p key={reason}>{reason}.</p>
        ))}
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {advice.options.map((option) => (
          <OptionCard key={option.runtime} option={option} inUse={option.runtime === current} />
        ))}
      </ul>
      {sandboxRuntimeChoice(advice) && (
        <>
          <RuntimeChoice station={station} advice={advice} current={current} />
          <AlsoWith cli={commands.setSandboxRuntime(station.name)} tool="update_station" />
        </>
      )}
    </Subsection>
  )
}
