import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy'
import { Mono, Section } from '@/components/page'
import { EgressFields } from '@/components/sandboxes-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import type { Sandbox } from '@/lib/api'
import { allowlistText, forwardCommand, parseAllowlist } from '@/lib/sandbox'

function EgressEditor({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'name' | 'egress'> }) {
  const client = useQueryClient()
  const [mode, setMode] = useState(sandbox.egress.mode)
  const [domains, setDomains] = useState(allowlistText(sandbox.egress.domains ?? []))
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (egress: { mode: 'open' } | { mode: 'allowlist'; domains: { domain: string; wildcard: boolean; ports: number[] }[] }) => unwrap(api.v1.sandboxes({ sandbox: sandbox.id }).patch({ egress }, idempotency())),
    onSuccess: () => {
      toast.success(`Egress of ${sandbox.name} saved`, { description: 'It applies to running connections at once.' })
      void client.invalidateQueries({ queryKey: ['sandboxes'] })
    },
    onError: failure => setError(failureText(failure))
  })
  return (
    <form
      className="max-w-xl space-y-3 rounded-lg border bg-card p-4"
      onSubmit={event => {
        event.preventDefault()
        setError(null)
        const parsed = parseAllowlist(domains)
        if (parsed.problem) return setError(parsed.problem)
        if (mode === 'allowlist' && parsed.entries.length === 0) return setError('An allowlist needs at least one domain.')
        mutation.mutate(mode === 'open' ? { mode } : { mode, domains: parsed.entries })
      }}
    >
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <EgressFields mode={mode} onMode={setMode} domains={domains} onDomains={setDomains} idPrefix="egress" />
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
      <div className="space-y-1.5">
        <Label htmlFor="forward-port">Port inside the sandbox</Label>
        <Input id="forward-port" type="number" min={1} max={65535} value={port} onChange={e => setPort(e.target.value)} className="w-32" aria-invalid={!valid} />
      </div>
      <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
        <span className="min-w-0 flex-1" data-testid="forward-command">
          <Mono className="break-all">{command}</Mono>
        </span>
        <CopyButton value={command} label="forward command" />
      </div>
      <p className="text-sm text-muted-foreground">
        Run it on your own machine. It listens on 127.0.0.1 and opens one connection per client, for previews. {sandbox.status !== 'running' && 'The sandbox must be running first.'}
      </p>
    </div>
  )
}

export function SandboxNetwork({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'name' | 'status' | 'egress'> }) {
  return (
    <div className="space-y-6">
      <Section title="Egress" description="Which public destinations the sandbox may reach. DNS answers for names that are not allowed are refused.">
        <EgressEditor sandbox={sandbox} />
      </Section>
      <Section title="Preview a port" description="The browser does not forward ports. Use the sly command on your machine.">
        <ForwardCommand sandbox={sandbox} />
      </Section>
    </div>
  )
}
