import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith, Code } from '@/components/code'
import { Confirm, RemoveButton } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Field } from '@/components/field'
import { FixActions } from '@/components/fix'
import { FormDialog } from '@/components/form-dialog'
import { EmptyState, ErrorState, Subsection } from '@/components/page'
import { Term } from '@/components/term'
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
import { api, idempotency, send, type AppPort, type Domain } from '@/lib/api'
import { seedItem } from '@/lib/cache'
import { commands, type AppScope } from '@/lib/commands'
import { planFix } from '@/lib/fixes'
import { entityIcon } from '@/lib/icons'
import { domainKind, domainStatus } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { domainsQuery, portsQuery } from '@/lib/queries'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const takesDomain = (port: AppPort) => port.protocol === 'http' && !port.grpc

const hostnameModes = [
  {
    value: 'generated',
    title: domainKind.generated,
    hint: 'Stationly picks a hostname for you.',
  },
  {
    value: 'custom',
    title: domainKind.custom,
    hint: 'A hostname on a zone in your Cloudflare account.',
  },
] as const

function AddDomain({
  app,
  scope,
  open,
  onOpenChange,
}: {
  app: string
  scope: AppScope
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ports = useQuery(portsQuery(app))
  const http = (ports.data?.items ?? []).filter(takesDomain)
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
    seed: (domain) => [seedItem(domainsQuery(app), domain)],
    invalidate: ['domains'],
    waiting: () =>
      mode === 'custom'
        ? `Add ${hostname.trim()} to ${scope.app}`
        : `Add a generated domain to ${scope.app}`,
    success: (body) => ({
      title: `${body.hostname} added`,
      description: body.tunnel_route
        ? 'Add the tunnel route shown on the domain row in Cloudflare.'
        : 'It goes live once Stationly reaches it through Cloudflare.',
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
          The <Term name="gateway" /> routes the hostname to an HTTP port of {scope.app}.
        </>
      }
      error={mutation.errorText}
      also={<AlsoWith cli={commands.addDomain(chosen || null)} tool="add_domain" />}
      submitLabel="Add domain"
      pending={mutation.isPending}
      submitDisabled={!chosen}
      onSubmit={() => mutation.mutate()}
    >
      {ports.isError && <ErrorState error={ports.error} title="Couldn’t load ports" />}
      {ports.data && http.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {scope.app} has no HTTP port that takes a domain. gRPC ports can’t have one.
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
    waiting: () => `Remove ${domain.hostname}`,
    success: () => `${domain.hostname} removed`,
  })

  return (
    <Confirm
      title={`Remove ${domain.hostname}?`}
      description="Visitors to it get an error right away. Tunnel routes you added in Cloudflare stay as they are."
      action="Remove domain"
      cancel="Keep domain"
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${domain.hostname}`} />}
    />
  )
}

export function DomainsPanel({ app, scope }: { app: string; scope: AppScope }) {
  const { data: domains } = useSuspenseQuery(domainsQuery(app))
  const { data: ports } = useSuspenseQuery(portsQuery(app))
  const [adding, setAdding] = useState(false)
  const portOf = new Map(ports.items.map((p) => [p.id, p.port]))
  const noHttp = !ports.items.some(takesDomain)
  const firstHttp = ports.items.find(takesDomain)?.id ?? null

  return (
    <Subsection
      title="Domains"
      description={
        <>
          Hostnames the <Term name="gateway" /> serves over HTTPS for {scope.app}.
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
          icon={entityIcon.domain}
          title="No domains yet"
          description={
            noHttp
              ? `Domains route to HTTP ports without gRPC, and ${scope.app} has none. Add one above.`
              : `A domain serves ${scope.app} over HTTPS on a hostname you own, or on a generated one.`
          }
          action={
            !noHttp && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add domain
              </Button>
            )
          }
          also={!noHttp && <AlsoWith cli={commands.addDomain(firstHttp)} tool="add_domain" />}
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {domains.items.map((domain) => (
            <li key={domain.id} className="space-y-2 bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <entityIcon.domain className="size-4 text-muted-foreground" aria-hidden />
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
                {portOf.get(domain.app_port_id) && (
                  <span className="text-xs text-muted-foreground">
                    Port {portOf.get(domain.app_port_id)}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <RemoveDomain domain={domain} />
                </span>
              </div>
              {domain.error && (
                <div className="space-y-1 text-sm">
                  <p className="text-destructive">{domain.error.summary}</p>
                  {(domain.error.fixes ?? []).map((fix) => (
                    <div key={fix.code} className="space-y-1.5">
                      <p className="text-foreground">{fix.text}</p>
                      <FixActions
                        plan={planFix(fix, {
                          ...scope,
                          subject: {
                            kind: 'app',
                            id: app,
                            name: scope.app,
                          },
                        })}
                        primary={false}
                      />
                    </div>
                  ))}
                  {domain.error.code && (
                    <p className="font-mono text-xs text-muted-foreground">{domain.error.code}</p>
                  )}
                </div>
              )}
              {domain.tunnel_route && (
                <div className="space-y-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs">
                  <p className="text-muted-foreground">
                    Add this public hostname to your tunnel in Cloudflare.
                  </p>
                  <p className="flex flex-wrap items-center gap-2">
                    <Code copy={domain.tunnel_route.hostname}>{domain.tunnel_route.hostname}</Code>
                    <span className="text-muted-foreground">to service</span>
                    <Code copy={domain.tunnel_route.service}>{domain.tunnel_route.service}</Code>
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddDomain app={app} scope={scope} open={adding} onOpenChange={setAdding} />}
    </Subsection>
  )
}
