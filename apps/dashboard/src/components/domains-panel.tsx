import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Globe, Plus, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith, Code } from '@/components/code'
import { Confirm, RemoveButton } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { EmptyState, ErrorState, Subsection } from '@/components/page'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
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
import { commands, type ServiceScope } from '@/lib/commands'
import { domainIngress, domainKind, domainStatus, sentence } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { domainsQuery, portsQuery, seedItem } from '@/lib/queries'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const hostnameModes = [
  {
    value: 'generated',
    title: domainKind.generated,
    hint: 'Stationly picks a hostname for you.',
  },
  {
    value: 'custom',
    title: domainKind.custom,
    hint: 'Point a DNS record you own at the station.',
  },
] as const

function AddDomain({
  service,
  scope,
  open,
  onOpenChange,
}: {
  service: string
  scope: ServiceScope
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
    seed: (domain) => [seedItem(domainsQuery(service), domain)],
    invalidate: ['domains'],
    staged: () =>
      mode === 'custom'
        ? `Add ${hostname.trim()} to ${scope.service}`
        : `Add a generated domain to ${scope.service}`,
    success: (body) => ({
      title: `${body.hostname} added`,
      description:
        body.kind === 'custom'
          ? 'Create the DNS record shown on the domain row.'
          : 'Stationly requests the certificate once the route is live.',
    }),
    onSuccess: () => onOpenChange(false),
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a domain"
      description={
        <>
          The <Term name="gateway" /> routes the hostname to an HTTP port of {scope.service} and
          requests a certificate.
        </>
      }
      error={mutation.errorText}
      also={
        <AlsoWith
          cli={commands.addDomain(scope, http.find((p) => p.id === chosen)?.port ?? null)}
          tool="add_domain"
        />
      }
      submitLabel="Add domain"
      pending={mutation.isPending}
      submitDisabled={!chosen}
      onSubmit={() => mutation.mutate()}
    >
      {ports.isError && <ErrorState error={ports.error} title="Couldn’t load ports" />}
      {ports.data && http.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {scope.service} has no HTTP port, so it can’t have a domain.
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
                    {p.port} {p.protocol.toUpperCase()}
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
    staged: () => `Remove ${domain.hostname}`,
    success: () => `${domain.hostname} removed`,
  })
  return (
    <Confirm
      title={`Remove ${domain.hostname}?`}
      description="Visitors to it get an error right away. DNS records you created stay as they are."
      action="Remove domain"
      cancel="Keep domain"
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${domain.hostname}`} />}
    />
  )
}

export function DomainsPanel({ service, scope }: { service: string; scope: ServiceScope }) {
  const { data: domains } = useSuspenseQuery(domainsQuery(service))
  const { data: ports } = useSuspenseQuery(portsQuery(service))
  const [adding, setAdding] = useState(false)
  const portOf = new Map(ports.items.map((p) => [p.id, p.port]))
  const noHttp = !ports.items.some((p) => p.protocol === 'http')
  const firstHttp = ports.items.find((p) => p.protocol === 'http')?.port ?? null
  return (
    <Subsection
      title="Domains"
      description={
        <>
          Hostnames the <Term name="gateway" /> serves over HTTPS for {scope.service}.
        </>
      }
      actions={
        domains.items.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={noHttp}>
            <Plus /> Add domain
          </Button>
        )
      }
    >
      {domains.items.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains yet"
          description={
            noHttp
              ? `Domains route to HTTP ports, and ${scope.service} has none. Switch a port to HTTP above to add one.`
              : `A domain serves ${scope.service} over HTTPS on a hostname you own, or on a generated one.`
          }
          action={
            !noHttp && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add domain
              </Button>
            )
          }
          also={
            !noHttp && <AlsoWith cli={commands.addDomain(scope, firstHttp)} tool="add_domain" />
          }
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {domains.items.map((domain) => (
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
                <span
                  className={cn('text-sm font-medium', toneText[domainStatus[domain.status].tone])}
                >
                  {domainStatus[domain.status].label}
                </span>
                <Badge variant="outline">{domainKind[domain.kind]}</Badge>
                <Badge variant="outline">{domainIngress[domain.ingress]}</Badge>
                {portOf.get(domain.service_port_id) && (
                  <span className="text-xs text-muted-foreground">
                    Port {portOf.get(domain.service_port_id)}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden />
                  Certificate {sentence(domain.certificate.status).toLowerCase()}
                  {domain.certificate.expires_at && (
                    <>
                      ,
                      <Time value={domain.certificate.expires_at} prefix="expires" />
                    </>
                  )}
                  <RemoveDomain domain={domain} />
                </span>
              </div>
              {domain.error && (
                <div className="space-y-1 text-sm">
                  <p className="text-destructive">{domain.error.summary}</p>
                  {(domain.error.fixes ?? []).map((fix) => (
                    <p key={fix.code} className="text-foreground">
                      {fix.text}
                    </p>
                  ))}
                  {domain.error.code && (
                    <p className="font-mono text-xs text-muted-foreground">{domain.error.code}</p>
                  )}
                </div>
              )}
              {domain.dns_instructions && domain.dns_instructions.length > 0 && (
                <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                  {domain.dns_instructions.map((record, i) => (
                    <p key={i} className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{record.type}</Badge>
                      <Code>{record.name}</Code>
                      <span className="text-muted-foreground">points to</span>
                      <Code>{record.value ?? 'not set yet'}</Code>
                      <span className="text-muted-foreground">{record.note}</span>
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddDomain service={service} scope={scope} open={adding} onOpenChange={setAdding} />
      )}
    </Subsection>
  )
}
