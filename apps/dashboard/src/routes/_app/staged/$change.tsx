import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'

import { Crumbs } from '@/components/crumbs'
import { ChangeDiff } from '@/components/diff'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { KeyValue, Mono, PageHeader, Section } from '@/components/page'
import { QueryState } from '@/components/query-state'
import { StagedStatusBadge } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, idempotency, unwrap, type Deployment, type StagedChange } from '@/lib/api'
import { actorText, ago, plural, stamp } from '@/lib/format'
import { stagedDecided } from '@/lib/invalidate'
import { done, useApiMutation } from '@/lib/mutation'
import { meQuery, stagedChangeQuery } from '@/lib/queries'
import { useEnvironmentTrail } from '@/lib/use-trail'

export const Route = createFileRoute('/_app/staged/$change')({
  component: StagedChangePage,
})

function StagedChangePage() {
  const { change: id } = Route.useParams()
  const change = useQuery(stagedChangeQuery(id))
  return (
    <QueryState query={change} rows={6} errorTitle="The staged change could not be loaded">
      {(c) => <StagedChangeView c={c} />}
    </QueryState>
  )
}

function StagedChangeView({ c }: { c: StagedChange }) {
  const me = useQuery(meQuery)
  const trail = useEnvironmentTrail(c.environment_id ?? undefined)
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [started, setStarted] = useState<Deployment[]>([])
  const accept = useApiMutation({
    mutationFn: async () =>
      done(
        await unwrap(
          api.v1['staged-changes']({
            id: c.id,
          }).accept.post(undefined, idempotency()),
        ),
      ),
    invalidate: stagedDecided,
    success: (result) => ({
      title: 'Change accepted',
      description: result.deployments?.length
        ? `${plural(result.deployments.length, 'deployment')} started.`
        : 'Applied.',
    }),
    onSuccess: (result) => !result.staged && setStarted(result.body.deployments ?? []),
    failure: () => 'Accept was refused',
  })
  const reject = useApiMutation({
    mutationFn: async () =>
      done(
        await unwrap(
          api.v1['staged-changes']({
            id: c.id,
          }).reject.post(
            reason.trim()
              ? {
                  reason: reason.trim(),
                }
              : {},
            idempotency(),
          ),
        ),
      ),
    invalidate: stagedDecided,
    success: () => 'Change rejected',
    onSuccess: () => setRejecting(false),
    failure: () => 'Reject was refused',
  })
  const human = me.data?.human === true
  const open = c.status === 'staged'
  const project = trail.project
  const environment = trail.environment

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            {
              label: 'Staged changes',
              to: '/staged',
            },
            {
              label: c.id,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              <Mono className="text-lg">{c.id}</Mono>
              <StagedStatusBadge status={c.status} />
            </span>
          }
          meta={
            <>
              {project && environment ? (
                <Link
                  to="/projects/$project/$environment"
                  params={{
                    project: project.name,
                    environment: environment.name,
                  }}
                  className="underline-offset-4 hover:underline"
                >
                  {project.name} / {environment.name}
                </Link>
              ) : (
                <span>{c.environment_id ? c.environment_id : 'platform'}</span>
              )}
              <span>
                from {actorText(c.actor)} via {c.source}
              </span>
              <span>{ago(c.created_at)}</span>
            </>
          }
          actions={
            open &&
            human && (
              <>
                <FormDialog
                  open={rejecting}
                  onOpenChange={setRejecting}
                  trigger={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={accept.isPending || reject.isPending}
                    >
                      <X /> Reject
                    </Button>
                  }
                  title="Reject this change?"
                  description="Nothing in the diff is applied. The reason is recorded and visible to the agent that asked."
                  submitLabel="Reject change"
                  submitVariant="destructive"
                  pending={reject.isPending}
                  onSubmit={() => reject.mutate()}
                >
                  <Field id="reject-reason" label="Reason (optional)">
                    <Textarea
                      id="reject-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                    />
                  </Field>
                </FormDialog>
                <Button
                  size="sm"
                  onClick={() => accept.mutate()}
                  disabled={accept.isPending || reject.isPending}
                >
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
          <AlertDescription>
            This session is not a human actor, so it cannot accept or reject staged changes in a
            protected environment.
          </AlertDescription>
        </Alert>
      )}
      {started.length > 0 && (
        <Alert>
          <Check />
          <AlertTitle>Applied</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-wrap gap-3">
              {started.map((d) => (
                <li key={d.id}>
                  <Link
                    to="/deployments/$deployment"
                    params={{
                      deployment: d.id,
                    }}
                    className="underline underline-offset-4"
                  >
                    deployment #{d.number}
                  </Link>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <KeyValue
        framed
        items={[
          ['Adds', c.summary.add],
          ['Updates', c.summary.update],
          ['Removes', c.summary.remove],
          ['Deployments', c.summary.deployments],
          ['Created', stamp(c.created_at)],
          ['Decided by', c.accepted_by ? actorText(c.accepted_by) : '—'],
        ]}
      />
      <Section
        title="Diff"
        description="Entries apply in this order inside one transaction. Variable values never appear here; a new value shows only its length and version."
      >
        {c.changes && c.changes.length > 0 ? (
          <ChangeDiff changes={c.changes} refs={c.refs} />
        ) : (
          <p className="text-sm text-muted-foreground">The diff is empty.</p>
        )}
      </Section>
    </div>
  )
}
