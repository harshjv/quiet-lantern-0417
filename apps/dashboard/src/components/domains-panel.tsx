import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Globe, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy'
import { Empty, ErrorState, Mono, Rows, Subsection } from '@/components/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, ApiFailure, idempotency, send } from '@/lib/api'
import { ago } from '@/lib/format'
import { domainsQuery, portsQuery } from '@/lib/queries'
import type { Domain } from '@/lib/api'
import { toastStaged } from '@/lib/staged'
import { cn } from '@/lib/utils'

const statusTone: Record<Domain['status'], string> = {
  active: 'text-emerald-700 dark:text-emerald-400',
  pending: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-700 dark:text-red-400'
}

function AddDomain({ service, open, onOpenChange }: { service: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const ports = useQuery(portsQuery(service))
  const http = (ports.data?.items ?? []).filter(p => p.protocol === 'http')
  const [port, setPort] = useState<string>('')
  const [mode, setMode] = useState<'generated' | 'custom'>('generated')
  const [hostname, setHostname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const chosen = port || http[0]?.id || ''
  const mutation = useMutation({
    mutationFn: () => send(api.v1.ports({ id: chosen }).domains.post(mode === 'generated' ? { generated: true } : { hostname: hostname.trim() }, idempotency())),
    onSuccess: result => {
      void client.invalidateQueries({ queryKey: ['domains'] })
      void client.invalidateQueries({ queryKey: ['services'] })
      void client.invalidateQueries({ queryKey: ['network'] })
      if (result.staged) {
        void client.invalidateQueries({ queryKey: ['staged'] })
        toastStaged(navigate, 'The domain was staged for review', result.body.id)
      } else toast.success(`${result.body.hostname} added`, { description: result.body.kind === 'custom' ? 'Create the DNS record shown on the domain row.' : 'The certificate is requested once the route is live.' })
      onOpenChange(false)
    },
    onError: failure => setError(failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : String(failure))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    mutation.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a domain</DialogTitle>
            <DialogDescription>The Gateway routes the hostname to an http port of this service and requests a certificate.</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {ports.isError && <ErrorState error={ports.error} title="Ports could not be read" />}
          {ports.data && http.length === 0 ? (
            <p className="text-sm text-muted-foreground">This service has no http port, so it cannot take a domain.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="domain-port">Port</Label>
                <Select value={chosen} onValueChange={setPort}>
                  <SelectTrigger id="domain-port" className="w-full">
                    <SelectValue placeholder="Choose a port" />
                  </SelectTrigger>
                  <SelectContent>
                    {http.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.port} ({p.protocol})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Hostname</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['generated', 'custom'] as const).map(value => (
                    <label key={value} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring')}>
                      <input type="radio" name="domain-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-0.5 accent-foreground" />
                      <span>
                        <span className="block font-medium">{value === 'generated' ? 'Generated' : 'Your own'}</span>
                        <span className="block text-xs text-muted-foreground">{value === 'generated' ? 'Under domains.zone, or sslip.io' : 'Point its DNS at the station'}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {mode === 'custom' && (
                <div className="space-y-1.5">
                  <Label htmlFor="domain-host">Hostname</Label>
                  <Input id="domain-host" required placeholder="app.example.com" value={hostname} onChange={e => setHostname(e.target.value)} className="font-mono" />
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!chosen || mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveDomain({ domain }: { domain: Domain }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: () => send(api.v1.domains({ id: domain.id }).delete(undefined, idempotency())),
    onSuccess: result => {
      void client.invalidateQueries({ queryKey: ['domains'] })
      void client.invalidateQueries({ queryKey: ['network'] })
      if (result.staged) {
        void client.invalidateQueries({ queryKey: ['staged'] })
        toastStaged(navigate, `Removing ${domain.hostname} was staged for review`, result.body.id)
      } else toast.success(`${domain.hostname} removed`)
    },
    onError: failure => toast.error('The domain was not removed', { description: failure instanceof Error ? failure.message : String(failure) })
  })
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${domain.hostname}`}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {domain.hostname}?</AlertDialogTitle>
          <AlertDialogDescription>The Gateway stops routing it at once. DNS records you created stay where they are.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => mutation.mutate()}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DomainsPanel({ service }: { service: string }) {
  const domains = useQuery(domainsQuery(service))
  const ports = useQuery(portsQuery(service))
  const [adding, setAdding] = useState(false)
  const portOf = new Map((ports.data?.items ?? []).map(p => [p.id, p.port]))
  const noHttp = ports.data !== undefined && !ports.data.items.some(p => p.protocol === 'http')
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
      {domains.isPending ? (
        <Rows count={2} />
      ) : domains.isError ? (
        <ErrorState error={domains.error} />
      ) : domains.data.items.length === 0 ? (
        <Empty title="No domains">{noHttp ? 'Domains route to http ports and this service has none. Change a port to http above to add one.' : 'Add a generated hostname or your own; sly domains add and the add_domain tool do the same.'}</Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {domains.data.items.map(domain => (
            <li key={domain.id} className="space-y-2 bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Globe className="size-4 text-muted-foreground" aria-hidden />
                <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer noopener" className="font-mono text-sm font-medium underline-offset-4 hover:underline">
                  {domain.hostname}
                </a>
                <CopyButton value={domain.hostname} label="hostname" />
                <span className={cn('text-sm font-medium', statusTone[domain.status])}>{domain.status}</span>
                <Badge variant="outline">{domain.kind}</Badge>
                <Badge variant="outline">{domain.ingress}</Badge>
                {portOf.get(domain.service_port_id) && <span className="text-xs text-muted-foreground">port {portOf.get(domain.service_port_id)}</span>}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden />
                  certificate {domain.certificate.status}
                  {domain.certificate.expires_at && `, expires ${ago(domain.certificate.expires_at)}`}
                  <RemoveDomain domain={domain} />
                </span>
              </div>
              {domain.error && (
                <div className="space-y-1 text-sm">
                  <p className="text-destructive">
                    {domain.error.code ? `${domain.error.code}: ` : ''}
                    {domain.error.summary}
                  </p>
                  {(domain.error.fixes ?? []).map(fix => (
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
      {adding && <AddDomain service={service} open={adding} onOpenChange={setAdding} />}
    </Subsection>
  )
}
