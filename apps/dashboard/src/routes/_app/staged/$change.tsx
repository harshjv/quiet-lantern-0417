import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'

import { Actor } from '@/components/actor'
import { Crumbs } from '@/components/crumbs'
import { ChangeDiff } from '@/components/diff'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { KeyValue, PageHeader, Section } from '@/components/page'
import { failurePage } from '@/components/panel'
import { StagedStatusBadge } from '@/components/status'
import { Time } from '@/components/time'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, idempotency, unwrap, type Deployment } from '@/lib/api'
import { seed } from '@/lib/cache'
import { plural, stamp } from '@/lib/format'
import { stagedDecided } from '@/lib/invalidate'
import { stagedSource } from '@/lib/labels'
import { done, useApiMutation } from '@/lib/mutation'
import { load, meQuery, seedDeployment, stagedChangeQuery } from '@/lib/queries'
import { loaderTitle } from '@/lib/title'
import { loadTrail, useEnvironmentTrail } from '@/lib/use-trail'

export const Route = createFileRoute('/_app/staged/$change')({
  loader: async ({ context, params }) => {
    const [change] = await Promise.all([
      load(context.queryClient, stagedChangeQuery(params.change)),
      load(context.queryClient, meQuery),
    ])

    return {
      title: [
        'Staged change',
        change.environment_id ? await loadTrail(context.queryClient, change.environment_id) : '',
      ],
    }
  },
  head: loaderTitle,
  errorComponent: failurePage('Couldn’t load this staged change'),
  component: StagedChangePage,
})

function Scope({ environmentId }: { environmentId: string }) {
  const { project, environment } = useEnvironmentTrail(environmentId)

  return (
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
  )
}

function StagedChangePage() {
  const { change: id } = Route.useParams()
  const { data: c } = useSuspenseQuery(stagedChangeQuery(id))
  const { data: me } = useSuspenseQuery(meQuery)
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
    seed: ({ deployments, ...change }) => [
      seed(stagedChangeQuery(c.id), {
        ...change,
        deployments: deployments.map((d) => d.id),
      }),
      ...deployments.flatMap(seedDeployment),
    ],
    invalidate: stagedDecided,
    success: (result) => ({
      title: 'Change accepted',
      description: result.deployments?.length
        ? `Started ${plural(result.deployments.length, 'deployment')}.`
        : undefined,
    }),
    onSuccess: (result) => !result.staged && setStarted(result.body.deployments ?? []),
    failure: () => 'accept this change',
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
    seed: (result) => [seed(stagedChangeQuery(c.id), result)],
    invalidate: stagedDecided,
    success: () => 'Change rejected',
    onSuccess: () => setRejecting(false),
    failure: () => 'reject this change',
  })
  const human = me.human
  const open = c.status === 'staged'

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
              <span className="font-mono text-lg">{c.id}</span>
              <StagedStatusBadge status={c.status} />
            </span>
          }
          meta={
            <>
              {c.environment_id ? (
                <Scope environmentId={c.environment_id} />
              ) : (
                <span>Platform</span>
              )}
              <span>
                Requested by <Actor actor={c.actor} /> through {stagedSource[c.source]}
              </span>
              <Time value={c.created_at} />
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
                  description="Stationly applies none of these changes. The agent that asked sees your reason."
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
      {open && !human && (
        <Alert>
          <ShieldAlert />
          <AlertTitle>Only a person can decide on this change</AlertTitle>
          <AlertDescription>
            You’re signed in with a token. Tokens can’t accept or reject changes to a protected
            environment.
          </AlertDescription>
        </Alert>
      )}
      {started.length > 0 && (
        <Alert>
          <Check />
          <AlertTitle>Change applied</AlertTitle>
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
                    Deployment #{d.number}
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
          ['Changes', c.summary.update],
          ['Removes', c.summary.remove],
          ['Starts', plural(c.summary.deployments, 'deployment')],
          ['Created', stamp(c.created_at)],
          ['Decided by', c.accepted_by ? <Actor key="decided" actor={c.accepted_by} /> : 'not yet'],
        ]}
      />
      <Section
        title="Changes"
        description="Stationly applies them in this order, all or nothing. Variable values stay hidden: a new value shows only its length and version."
      >
        {c.changes && c.changes.length > 0 ? (
          <ChangeDiff changes={c.changes} refs={c.refs} />
        ) : (
          <p className="text-sm text-muted-foreground">This change has no entries.</p>
        )}
      </Section>
    </div>
  )
}
