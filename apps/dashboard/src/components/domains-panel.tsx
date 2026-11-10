import { useQuery } from '@tanstack/react-query'
import { Globe, Plus, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { Confirm, RemoveButton } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Empty, ErrorState, Mono, Subsection } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, idempotency, send, type Domain } from '@/lib/api'
import { ago } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { domainsQuery, portsQuery } from '@/lib/queries'
import { toneText, type Tone } from '@/lib/tone'
import { cn } from '@/lib/utils'

const statusTone: Record<Domain['status'], Tone> = {
  active: 'success',
  pending: 'warning',
  error: 'danger',
}

const hostnameModes = [
  {
    value: 'generated',
    title: 'Generated',
    hint: 'Under domains.zone, or sslip.io',
  },
  {
    value: 'custom',
    title: 'Your own',
    hint: 'Point its DNS at the station',
  },
] as const

function AddDomain({
  service,
  open,
  onOpenChange,
}: {
  service: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ports = useQuery(portsQuery(service))
  const http = (ports.data?.items ?? []).filter((p) => p.protocol === 'http')
  const [port, setPort] = useState<string>('')
  const [mode, setMode] = useState<'generated' | 'custom'>('generated')
  const [hostname, setHostname] = useState('')
  const chosen = port || http[0]?.id || ''
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .ports({
            id: chosen,
          })
          .domains.post(
            mode === 'generated'
              ? {
                  generated: true,
                }
              : {
                  hostname: hostname.trim(),
                },
            idempotency(),
          ),
      ),
    invalidate: ['domains'],
    staged: () => 'The domain was staged for review',
    success: (body) => ({
      title: `${body.hostname} added`,
      description:
        body.kind === 'custom'
          ? 'Create the DNS record shown on the domain row.'
          : 'The certificate is requested once the route is live.',
    }),
    onSuccess: () => onOpenChange(false),
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a domain"
      description="The Gateway routes the hostname to an http port of this service and requests a certificate."
      error={mutation.errorText}
      submitLabel="Add domain"
      pending={mutation.isPending}
      submitDisabled={!chosen}
      onSubmit={() => mutation.mutate()}
    >
      {ports.isError && <ErrorState error={ports.error} title="Ports could not be read" />}
      {ports.data && http.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This service has no http port, so it cannot take a domain.
        </p>
      ) : (
        <>
          <Field id="domain-port" label="Port">
            <Select value={chosen} onValueChange={setPort}>
              <SelectTrigger id="domain-port" className="w-full">
                <SelectValue placeholder="Choose a port" />
              </SelectTrigger>
              <SelectContent>
                {http.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.port} ({p.protocol})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <ChoiceCards
            name="domain-mode"
            legend="Hostname"
            value={mode}
            onChange={setMode}
            options={hostnameModes}
          />
          {mode === 'custom' && (
            <Field id="domain-host" label="Hostname">
              <Input
                id="domain-host"
                required
                placeholder="app.example.com"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                className="font-mono"
              />
            </Field>
          )}
        </>
      )}
    </FormDialog>
  )
}

function RemoveDomain({ domain }: { domain: Domain }) {
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .domains({
            id: domain.id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['domains'],
    staged: () => `Removing ${domain.hostname} was staged for review`,
    success: () => `${domain.hostname} removed`,
  })
  return (
    <Confirm
      title={`Remove ${domain.hostname}?`}
      description="The Gateway stops routing it at once. DNS records you created stay where they are."
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${domain.hostname}`} />}
    />
  )
}

export function DomainsPanel({ service }: { service: string }) {
  const domains = useQuery(domainsQuery(service))
  const ports = useQuery(portsQuery(service))
  const [adding, setAdding] = useState(false)
  const portOf = new Map((ports.data?.items ?? []).map((p) => [p.id, p.port]))
  const noHttp = ports.data !== undefined && !ports.data.items.some((p) => p.protocol === 'http')
  return (
    <Subsection
      title="Domains"
      description="Public hostnames the Gateway routes to an http port, with a certificate."
      actions={
        <Button size="sm" onClick={() => setAdding(true)} disabled={noHttp}>
          <Plus /> Add domain
        </Button>
      }
    >
      <QueryState
        query={domains}
        rows={2}
        isEmpty={noItems}
        empty={
          <Empty title="No domains">
            {noHttp
              ? 'Domains route to http ports and this service has none. Change a port to http above to add one.'
              : 'Add a generated hostname or your own; sly domains add and the add_domain tool do the same.'}
          </Empty>
        }
      >
        {(data) => (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {data.items.map((domain) => (
              <li key={domain.id} className="space-y-2 bg-card px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Globe className="size-4 text-muted-foreground" aria-hidden />
                  <a
                    href={`https://${domain.hostname}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-mono text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {domain.hostname}
                  </a>
                  <CopyButton value={domain.hostname} label="hostname" />
                  <span className={cn('text-sm font-medium', toneText[statusTone[domain.status]])}>
                    {domain.status}
                  </span>
                  <Badge variant="outline">{domain.kind}</Badge>
                  <Badge variant="outline">{domain.ingress}</Badge>
                  {portOf.get(domain.service_port_id) && (
                    <span className="text-xs text-muted-foreground">
                      port {portOf.get(domain.service_port_id)}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="size-3.5" aria-hidden />
                    certificate {domain.certificate.status}
                    {domain.certificate.expires_at &&
                      `, expires ${ago(domain.certificate.expires_at)}`}
                    <RemoveDomain domain={domain} />
                  </span>
                </div>
                {domain.error && (
                  <div className="space-y-1 text-sm">
                    <p className="text-destructive">
                      {domain.error.code ? `${domain.error.code}: ` : ''}
                      {domain.error.summary}
                    </p>
                    {(domain.error.fixes ?? []).map((fix) => (
                      <p key={fix.code} className="text-muted-foreground">
                        <Mono className="mr-2 text-xs">{fix.code}</Mono>
                        {fix.text}
                      </p>
                    ))}
                  </div>
                )}
                {domain.dns_instructions && domain.dns_instructions.length > 0 && (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                    {domain.dns_instructions.map((record, i) => (
                      <p key={i} className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{record.type}</Badge>
                        <Mono>{record.name}</Mono>→<Mono>{record.value ?? '—'}</Mono>
                        <span className="text-muted-foreground">{record.note}</span>
                      </p>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {adding && <AddDomain service={service} open={adding} onOpenChange={setAdding} />}
    </Subsection>
  )
}
