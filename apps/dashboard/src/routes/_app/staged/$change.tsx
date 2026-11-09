import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Crumbs } from '@/components/crumbs'
import { ChangeDiff } from '@/components/diff'
import { ErrorState, KeyValue, Mono, PageHeader, Rows, Section } from '@/components/page'
import { StagedStatusBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiFailure, idempotency, unwrap } from '@/lib/api'
import { ago, stamp } from '@/lib/format'
import { environmentQuery, meQuery, projectQuery, stagedChangeQuery } from '@/lib/queries'
import type { Deployment } from '@/lib/api'

export const Route = createFileRoute('/_app/staged/$change')({
  component: StagedChangePage
})


const describe = (failure: unknown) => (failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : failure instanceof Error ? failure.message : String(failure))

function StagedChangePage() {
  const { change: id } = Route.useParams()
  const client = useQueryClient()
  const change = useQuery(stagedChangeQuery(id))
  const me = useQuery(meQuery)
  const environment = useQuery({ ...environmentQuery(change.data?.environment_id ?? ''), enabled: Boolean(change.data?.environment_id) })
  const project = useQuery({ ...projectQuery(environment.data?.project_id ?? ''), enabled: Boolean(environment.data) })
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [started, setStarted] = useState<Deployment[]>([])
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['staged'] })
    void client.invalidateQueries({ queryKey: ['environments'] })
    void client.invalidateQueries({ queryKey: ['services'] })
    void client.invalidateQueries({ queryKey: ['variables'] })
    void client.invalidateQueries({ queryKey: ['domains'] })
    void client.invalidateQueries({ queryKey: ['ports'] })
    void client.invalidateQueries({ queryKey: ['port-allocations'] })
    void client.invalidateQueries({ queryKey: ['network'] })
    void client.invalidateQueries({ queryKey: ['deployments'] })
  }
  const accept = useMutation({
    mutationFn: () => unwrap(api.v1['staged-changes']({ id }).accept.post(undefined, idempotency())),
    onSuccess: result => {
      setStarted(result.deployments ?? [])
      refresh()
      toast.success('Change accepted', { description: result.deployments?.length ? `${result.deployments.length} deployment${result.deployments.length === 1 ? '' : 's'} started.` : 'Applied.' })
    },
    onError: failure => toast.error('Accept was refused', { description: describe(failure) })
  })
  const reject = useMutation({
    mutationFn: () => unwrap(api.v1['staged-changes']({ id }).reject.post(reason.trim() ? { reason: reason.trim() } : {}, idempotency())),
    onSuccess: () => {
      setRejecting(false)
      refresh()
      toast.success('Change rejected')
    },
    onError: failure => toast.error('Reject was refused', { description: describe(failure) })
  })

  if (change.isPending) return <Rows count={6} />
  if (change.isError) return <ErrorState error={change.error} title="The staged change could not be loaded" />
  const c = change.data
  const human = me.data?.human === true
  const open = c.status === 'staged'

  return (
    <div className="space-y-6">
      <div>
        <Crumbs items={[{ label: 'Staged changes', to: '/staged' }, { label: c.id }]} />
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              <Mono className="text-lg">{c.id}</Mono>
              <StagedStatusBadge status={c.status} />
            </span>
          }
          meta={
            <>
              {project.data && environment.data ? (
                <Link to="/projects/$project/$environment" params={{ project: project.data.name, environment: environment.data.name }} className="underline-offset-4 hover:underline">
                  {project.data.name} / {environment.data.name}
                </Link>
              ) : (
                <span>{c.environment_id ? c.environment_id : 'platform'}</span>
              )}
              <span>
                from {c.actor.type}
                {c.actor.client ? ` (${c.actor.client})` : ''} via {c.source}
              </span>
              <span>{ago(c.created_at)}</span>
            </>
          }
          actions={
            open &&
            human && (
              <>
                <Dialog open={rejecting} onOpenChange={setRejecting}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={accept.isPending || reject.isPending}>
                      <X /> Reject
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Reject this change?</DialogTitle>
                      <DialogDescription>Nothing in the diff is applied. The reason is recorded and visible to the agent that asked.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5">
                      <Label htmlFor="reject-reason">Reason (optional)</Label>
                      <Textarea id="reject-reason" value={reason} onChange={e => setReason(e.target.value)} rows={3} />
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setRejecting(false)}>
                        Cancel
                      </Button>
                      <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
                        {reject.isPending && <Loader2 className="animate-spin" />}
                        Reject change
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button size="sm" onClick={() => accept.mutate()} disabled={accept.isPending || reject.isPending}>
                  {accept.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                  Accept and apply
                </Button>
              </>
            )
          }
        />
      </div>
      {open && me.data && !human && (
        <Alert>
          <ShieldAlert />
          <AlertTitle>A human accepts this change</AlertTitle>
          <AlertDescription>This session is not a human actor, so it cannot accept or reject staged changes in a protected environment.</AlertDescription>
        </Alert>
      )}
      {started.length > 0 && (
        <Alert>
          <Check />
          <AlertTitle>Applied</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-wrap gap-3">
              {started.map(d => (
                <li key={d.id}>
                  <Link to="/deployments/$deployment" params={{ deployment: d.id }} className="underline underline-offset-4">
                    deployment #{d.number}
                  </Link>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="rounded-lg border bg-card p-4">
        <KeyValue
          items={[
            ['Adds', c.summary.add],
            ['Updates', c.summary.update],
            ['Removes', c.summary.remove],
            ['Deployments', c.summary.deployments],
            ['Created', stamp(c.created_at)],
            ['Decided by', c.accepted_by ? `${c.accepted_by.type}${c.accepted_by.client ? ` (${c.accepted_by.client})` : ''}` : '—']
          ]}
        />
      </div>
      <Section title="Diff" description="Entries apply in this order inside one transaction. Variable values never appear here; a new value shows only its length and version.">
        {c.changes && c.changes.length > 0 ? <ChangeDiff changes={c.changes} refs={c.refs} /> : <p className="text-sm text-muted-foreground">The diff is empty.</p>}
      </Section>
    </div>
  )
}
