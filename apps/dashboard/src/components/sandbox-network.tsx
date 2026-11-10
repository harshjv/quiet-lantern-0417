import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { CopyButton } from '@/components/copy'
import { Field } from '@/components/field'
import { FormError } from '@/components/form-dialog'
import { Mono, Section } from '@/components/page'
import { EgressFields } from '@/components/sandboxes-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, idempotency, send, type Sandbox } from '@/lib/api'
import { useApiMutation } from '@/lib/mutation'
import { allowlistText, egressBody, forwardCommand, type Egress } from '@/lib/sandbox'

function EgressEditor({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'name' | 'egress'> }) {
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
    invalidate: ['sandboxes'],
    success: () => ({
      title: `Egress of ${sandbox.name} saved`,
      description: 'It applies to running connections at once.',
    }),
  })
  return (
    <form
      className="max-w-xl space-y-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        const body = egressBody(mode, domains)
        setProblem(body.problem)
        if (body.egress) mutation.mutate(body.egress)
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
        Save egress
      </Button>
    </form>
  )
}

function ForwardCommand({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'status'> }) {
  const [port, setPort] = useState('3000')
  const valid = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65_535
  const command = forwardCommand(sandbox.id, valid ? Number(port) : 3000)
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
      <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
        <span className="min-w-0 flex-1" data-testid="forward-command">
          <Mono className="break-all">{command}</Mono>
        </span>
        <CopyButton value={command} label="forward command" />
      </div>
      <p className="text-sm text-muted-foreground">
        Run it on your own machine. It listens on 127.0.0.1 and opens one connection per client, for
        previews. {sandbox.status !== 'running' && 'The sandbox must be running first.'}
      </p>
    </div>
  )
}

export function SandboxNetwork({
  sandbox,
}: {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'status' | 'egress'>
}) {
  return (
    <div className="space-y-6">
      <Section
        title="Egress"
        description="Which public destinations the sandbox may reach. DNS answers for names that are not allowed are refused."
      >
        <EgressEditor sandbox={sandbox} />
      </Section>
      <Section
        title="Preview a port"
        description="The browser does not forward ports. Use the sly command on your machine."
      >
        <ForwardCommand sandbox={sandbox} />
      </Section>
    </div>
  )
}
