import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, RefreshCw, Rocket, TriangleAlert, Undo2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiFailure, idempotency, send } from '@/lib/api'
import type { Deployment, SentOf, Service } from '@/lib/api'
import { deploymentsQuery } from '@/lib/queries'

type Started = SentOf<ReturnType<typeof api.v1.services>['redeploy']['post']>

const describe = (failure: unknown) => (failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : failure instanceof Error ? failure.message : String(failure))

const useStarted = (service: Service) => {
  const client = useQueryClient()
  const navigate = useNavigate()
  return (result: Started, verb: string) => {
    void client.invalidateQueries({ queryKey: ['deployments'] })
    void client.invalidateQueries({ queryKey: ['services'] })
    if (result.staged) {
      toast.message(`${verb} was staged for review`, { description: 'This environment is protected; accept the change to start it.' })
      void navigate({ to: '/staged/$change', params: { change: result.body.id } })
      return
    }
    for (const warning of result.body.warnings ?? []) toast.warning(warning.code, { description: warning.explanation })
    toast.success(`${verb} started`, { description: `${service.name} deployment #${result.body.number}` })
    void navigate({ to: '/deployments/$deployment', params: { deployment: result.body.id } })
  }
}

export function DeployButton({ service }: { service: Service }) {
  const started = useStarted(service)
  const [open, setOpen] = useState(false)
  const image = service.source.type === 'image' ? service.source.ref : null
  const [ref, setRef] = useState(image ?? '')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => {
      const body = service.source.type === 'image' ? { image: ref.trim() } : ref.trim() ? { source_ref: ref.trim() } : {}
      return send(api.v1.services({ service: service.id }).deployments.post(body, idempotency()))
    },
    onSuccess: result => {
      setOpen(false)
      started(result, 'Deploy')
    },
    onError: failure => setError(describe(failure))
  })
  const repo = service.source.type === 'dockerfile' || service.source.type === 'railpack'
  if (service.source.type === 'local' || service.source.type === 'template') return null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    mutation.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Rocket /> Deploy
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Deploy {service.name}</DialogTitle>
            <DialogDescription>{repo ? 'Builds the source and rolls it out with the service strategy.' : 'Rolls out this image with the service strategy.'}</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="deploy-ref">{repo ? 'Commit, branch or tag (optional)' : 'Image'}</Label>
            <Input id="deploy-ref" required={!repo} value={ref} onChange={e => setRef(e.target.value)} placeholder={repo && service.source.type !== 'image' ? (service.source as { branch: string }).branch : 'nginx:1.27'} className="font-mono" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RedeployButton({ service }: { service: Service }) {
  const started = useStarted(service)
  const mutation = useMutation({
    mutationFn: () => send(api.v1.services({ service: service.id }).redeploy.post({}, idempotency())),
    onSuccess: result => started(result, 'Redeploy'),
    onError: failure => toast.error('Redeploy was refused', { description: describe(failure) })
  })
  return (
    <Button size="sm" variant="outline" onClick={() => mutation.mutate()} disabled={!service.current_deployment_id || mutation.isPending}>
      {mutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Redeploy
    </Button>
  )
}

export function RollbackButton({ service, deployment }: { service: Service; deployment: Deployment }) {
  const started = useStarted(service)
  const [confirm, setConfirm] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (stale: boolean) =>
      send(api.v1.services({ service: service.id }).rollback.post({ deployment_id: deployment.id, ...(stale ? { confirm_stale_secrets: true } : {}) }, idempotency())),
    onSuccess: result => started(result, `Rollback to #${deployment.number}`),
    onError: failure => {
      if (failure instanceof ApiFailure && failure.code === 'STALE_SECRETS_CONFIRM_REQUIRED') setConfirm(failure.message)
      else toast.error('Rollback was refused', { description: describe(failure) })
    }
  })
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => mutation.mutate(false)} disabled={mutation.isPending} aria-label={`Roll back to deployment ${deployment.number}`}>
        {mutation.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />}
        Roll back
      </Button>
      <AlertDialog open={confirm !== null} onOpenChange={open => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back with older secret versions?</AlertDialogTitle>
            <AlertDialogDescription>{confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(null)
                mutation.mutate(true)
              }}
            >
              Roll back anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const openStatuses = new Set(['queued', 'building', 'pre_deploy', 'starting', 'waiting_health', 'cutover', 'draining'])

const staleTitle = (codes: Set<string>) =>
  codes.has('VARIABLES_CHANGED') && codes.has('CONFIG_CHANGED')
    ? 'Variables and configuration changed, deploy to apply'
    : codes.has('VARIABLES_CHANGED')
      ? 'Variables changed, deploy to apply'
      : 'Configuration changed, deploy to apply'

export function StaleBanner({ service }: { service: Service }) {
  const started = useStarted(service)
  const deployments = useQuery({ ...deploymentsQuery(service.id), enabled: service.stale })
  const mutation = useMutation({
    mutationFn: () => send(api.v1.services({ service: service.id }).redeploy.post({}, idempotency())),
    onSuccess: result => started(result, 'Deploy'),
    onError: failure => toast.error('Deploy was refused', { description: describe(failure) })
  })
  const reasons = service.stale_reasons ?? []
  if (!service.stale || reasons.length === 0) return null
  const rolling = deployments.data?.items.find(d => openStatuses.has(d.status))
  const sourceChanged = reasons.some(r => r.code === 'CONFIG_CHANGED' && r.keys.includes('source'))
  return (
    <Alert role="status" className="flex flex-col gap-3 border-amber-300 bg-amber-50 text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50" data-testid="stale-banner">
      <div className="flex gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
        <div className="space-y-1">
          <AlertTitle>{staleTitle(new Set(reasons.map(r => r.code)))}</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-100">
            {reasons.map(r => (
              <p key={r.code} className="mb-0!">
                {r.explanation}
              </p>
            ))}
            {rolling && <p className="mb-0!">Deployment #{rolling.number} is {rolling.status.replace('_', ' ')}; the banner clears when a deployment with these values is active.</p>}
          </AlertDescription>
        </div>
      </div>
      {!rolling &&
        (sourceChanged ? (
          <DeployButton service={service} />
        ) : (
          <Button size="sm" className="shrink-0 self-start sm:self-center" onClick={() => mutation.mutate()} disabled={!service.current_deployment_id || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
            Deploy
          </Button>
        ))}
    </Alert>
  )
}
