import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, failureText, idempotency, send } from '@/lib/api'
import type { Environment, Variable } from '@/lib/api'
import { slugPattern, slugTitle } from '@/lib/format'

type Kind = 'web' | 'worker'

type PortRow = { row: string; port: string; protocol: 'http' | 'tcp' }

type VariableRow = { row: string; key: string; kind: Variable['kind']; value: string }

const nextRow = () => crypto.randomUUID()

const onlineStationsQuery = {
  queryKey: ['stations', 'online'],
  queryFn: async () => {
    const result = await api.v1.stations.get({ query: { status: 'online', limit: 200 } })
    return result.error ? [] : (result.data?.items ?? [])
  },
  staleTime: 60_000
}

export function NewService({ environment, open, onOpenChange }: { environment: Environment; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const stations = useQuery(onlineStationsQuery)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('web')
  const [image, setImage] = useState('')
  const [ports, setPorts] = useState<PortRow[]>(() => [{ row: nextRow(), port: '8080', protocol: 'http' }])
  const [variables, setVariables] = useState<VariableRow[]>([])
  const [station, setStation] = useState('')
  const [deploy, setDeploy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const choices = stations.data ?? []

  const mutation = useMutation({
    mutationFn: () =>
      send(
        api.v1.environments({ environment: environment.id }).services.post(
          {
            name,
            kind,
            source: { type: 'image', ref: image.trim() },
            ports: kind === 'web' ? ports.map(p => ({ port: Number(p.port), protocol: p.protocol })) : [],
            variables: variables.map(v => (v.kind === 'reference' ? { key: v.key, kind: v.kind, reference: v.value } : { key: v.key, kind: v.kind, value: v.value })),
            station_id: station || undefined,
            deploy_on_create: deploy
          },
          idempotency()
        )
      ),
    onSuccess: result => {
      void client.invalidateQueries({ queryKey: ['services'] })
      void client.invalidateQueries({ queryKey: ['environments'] })
      void client.invalidateQueries({ queryKey: ['projects'] })
      onOpenChange(false)
      if (result.staged) {
        void client.invalidateQueries({ queryKey: ['staged'] })
        toast.message(`${name} was staged for review`, {
          description: `${environment.name} is protected; the service is created when a human accepts the change.`,
          action: { label: 'Review', onClick: () => void navigate({ to: '/staged/$change', params: { change: result.body.id } }) }
        })
        return
      }
      const started = result.body.deployments.length
      toast.success(`${result.body.name} created`, { description: started ? 'The first deployment started.' : 'Deploy it from the service page when you are ready.' })
      for (const warning of result.body.warnings) toast.warning(warning.code, { description: warning.explanation })
      void navigate({ to: '/services/$service', params: { service: result.body.id } })
    },
    onError: failure => setError(failureText(failure))
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    mutation.mutate()
  }

  const updatePort = (row: string, patch: Partial<PortRow>) => setPorts(list => list.map(p => (p.row === row ? { ...p, ...patch } : p)))
  const updateVariable = (row: string, patch: Partial<VariableRow>) => setVariables(list => list.map(v => (v.row === row ? { ...v, ...patch } : v)))

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="space-y-5" autoComplete="off">
          <DialogHeader>
            <DialogTitle>Create a service from an image</DialogTitle>
            <DialogDescription>
              In {environment.name}. sly services create --image and the create_service tool do the same; repositories and templates are created there or from a Manifest.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div className="space-y-1.5">
              <Label htmlFor="service-name">Name</Label>
              <Input id="service-name" required pattern={slugPattern} title={slugTitle} value={name} onChange={e => setName(e.target.value.toLowerCase())} className="font-mono" placeholder="web" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-kind">Kind</Label>
              <Select value={kind} onValueChange={v => setKind(v as Kind)}>
                <SelectTrigger id="service-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">web</SelectItem>
                  <SelectItem value="worker">worker</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-image">Image</Label>
            <Input
              id="service-image"
              required
              value={image}
              onChange={e => setImage(e.target.value)}
              className="font-mono"
              placeholder="traefik/whoami@sha256:…"
              spellCheck={false}
              aria-describedby="service-image-hint"
            />
            <p id="service-image-hint" className="text-xs text-muted-foreground">
              Dispatch resolves a tag such as nginx:1.27 to its image digest when you create the service and shows that digest on the service and each deployment. Redeploys keep it; Deploy resolves the tag again.
            </p>
          </div>

          {kind === 'web' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Ports</legend>
              <p className="text-xs text-muted-foreground">http ports can take a domain; tcp ports can be exposed on a host port.</p>
              <ul className="space-y-2">
                {ports.map((p, i) => (
                  <li key={p.row} className="flex items-center gap-2">
                    <Input
                      aria-label={`Port ${i + 1} number`}
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={p.port}
                      onChange={e => updatePort(p.row, { port: e.target.value })}
                      className="w-28 font-mono"
                    />
                    <Select value={p.protocol} onValueChange={v => updatePort(p.row, { protocol: v as PortRow['protocol'] })}>
                      <SelectTrigger aria-label={`Port ${i + 1} protocol`} className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="http">http</SelectItem>
                        <SelectItem value="tcp">tcp</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove port ${i + 1}`} disabled={ports.length === 1} onClick={() => setPorts(list => list.filter(x => x.row !== p.row))}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="button" variant="outline" size="sm" onClick={() => setPorts(list => [...list, { row: nextRow(), port: '', protocol: 'http' }])}>
                <Plus /> Add port
              </Button>
            </fieldset>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Variables (optional)</legend>
            {variables.length > 0 && (
              <ul className="space-y-2">
                {variables.map((v, i) => (
                  <li key={v.row} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 sm:grid-cols-[10rem_7rem_1fr_auto]">
                    <Input
                      aria-label={`Variable ${i + 1} key`}
                      required
                      pattern="[A-Z_][A-Z0-9_]*"
                      title="Upper case letters, digits and underscores"
                      value={v.key}
                      onChange={e => updateVariable(v.row, { key: e.target.value.toUpperCase() })}
                      className="font-mono"
                      placeholder="KEY"
                    />
                    <Select value={v.kind} onValueChange={value => updateVariable(v.row, { kind: value as Variable['kind'] })}>
                      <SelectTrigger aria-label={`Variable ${i + 1} kind`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="literal">literal</SelectItem>
                        <SelectItem value="sealed">sealed</SelectItem>
                        <SelectItem value="reference">reference</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label={`Variable ${i + 1} ${v.kind === 'reference' ? 'reference' : 'value'}`}
                      type={v.kind === 'sealed' ? 'password' : 'text'}
                      autoComplete={v.kind === 'sealed' ? 'new-password' : 'off'}
                      required
                      value={v.value}
                      onChange={e => updateVariable(v.row, { value: e.target.value })}
                      className="col-span-2 font-mono sm:col-span-1"
                      placeholder={v.kind === 'reference' ? '${{db.HOST}}' : 'value'}
                      spellCheck={false}
                    />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove variable ${i + 1}`} className="col-start-3 row-start-1 sm:col-start-4" onClick={() => setVariables(list => list.filter(x => x.row !== v.row))}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setVariables(list => [...list, { row: nextRow(), key: '', kind: 'literal', value: '' }])}>
              <Plus /> Add variable
            </Button>
            {variables.some(v => v.kind === 'sealed') && <p className="text-xs text-muted-foreground">Sealed values are write-only. No endpoint returns them, including to you.</p>}
          </fieldset>

          {choices.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="service-station">Station</Label>
              <Select value={station} onValueChange={setStation}>
                <SelectTrigger id="service-station" className="w-full">
                  <SelectValue placeholder="Choose a station" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox id="service-deploy" checked={deploy} onCheckedChange={v => setDeploy(v === true)} />
            <Label htmlFor="service-deploy" className="font-normal">
              Deploy when created
            </Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || (choices.length > 1 && !station)}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Create service
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
