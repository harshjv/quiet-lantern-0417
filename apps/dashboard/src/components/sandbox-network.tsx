import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { CommandBlock } from '@/components/code'
import { Field } from '@/components/field'
import { FormError } from '@/components/form-dialog'
import { Section } from '@/components/page'
import { EgressFields } from '@/components/sandboxes-panel'
import { Term } from '@/components/term'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, idempotency, send, type Sandbox } from '@/lib/api'
import { commands } from '@/lib/commands'
import { useApiMutation } from '@/lib/mutation'
import { patchSandbox, seedSandbox } from '@/lib/queries'
import { allowlistText, egressBody, type Egress } from '@/lib/sandbox'

function EgressEditor({
  sandbox,
}: {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'egress' | 'environment_id'>
}) {
  const [mode, setMode] = useState(sandbox.egress.mode)
  const [domains, setDomains] = useState(allowlistText(sandbox.egress.domains ?? []))
  const [problem, setProblem] = useState<string | null>(null)
  const mutation = useApiMutation({
    mutationFn: (egress: Egress) =>
      send(
        api.v1
          .sandboxes({
            sandbox: sandbox.id,
          })
          .patch(
            {
              egress,
            },
            idempotency(),
          ),
      ),
    optimistic: (egress) =>
      patchSandbox(sandbox, {
        egress,
      }),
    seed: seedSandbox,
    invalidate: ['sandboxes'],
    success: () => ({
      title: `Outbound traffic for ${sandbox.name} saved`,
      description: 'Open connections follow the new rules now.',
    }),
    failure: () => `save outbound traffic for ${sandbox.name}`,
  })

  return (
    <form
      className="max-w-xl space-y-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        const body = egressBody(mode, domains)

        setProblem(body.problem)

        if (body.egress) {
          mutation.mutate(body.egress)
        }
      }}
    >
      <FormError>{problem ?? mutation.errorText}</FormError>
      <EgressFields
        mode={mode}
        onMode={setMode}
        domains={domains}
        onDomains={setDomains}
        idPrefix="egress"
      />
      <Button type="submit" size="sm" disabled={mutation.isPending}>
        {mutation.isPending && <Loader2 className="animate-spin" />}
        Save outbound traffic
      </Button>
    </form>
  )
}

function ForwardCommand({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'status'> }) {
  const [port, setPort] = useState('3000')
  const valid = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65_535
  const command = commands.forward(sandbox.id, valid ? Number(port) : 3000)

  return (
    <div className="max-w-xl space-y-3 rounded-lg border bg-card p-4">
      <Field id="forward-port" label="Port inside the sandbox">
        <Input
          id="forward-port"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="w-32"
          aria-invalid={!valid}
        />
      </Field>
      <CommandBlock
        commands={command}
        caption="Run on your computer"
        data-testid="forward-command"
      />
      <p className="text-sm text-muted-foreground">
        It listens on 127.0.0.1 and opens one connection per browser tab, for previews.{' '}
        {sandbox.status !== 'running' && 'Start the sandbox first.'}
      </p>
    </div>
  )
}

export function SandboxNetwork({
  sandbox,
}: {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'status' | 'egress' | 'environment_id'>
}) {
  return (
    <div className="space-y-6">
      <Section
        title={<Term name="outboundTraffic" />}
        description="Public destinations this sandbox can reach. Lookups for other names fail."
      >
        <EgressEditor sandbox={sandbox} />
      </Section>
      <Section
        title="Preview a port"
        description="Run this on your computer to open the port at localhost. It needs sly, logged in to this instance."
      >
        <ForwardCommand sandbox={sandbox} />
      </Section>
    </div>
  )
}
