import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, RefreshCw, Rocket, TriangleAlert, Undo2 } from 'lucide-react'
import { useState } from 'react'

import { Confirm } from '@/components/confirm'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  api,
  ApiFailure,
  idempotency,
  send,
  type Deployment,
  type SentOf,
  type Service,
} from '@/lib/api'
import { useApiMutation } from '@/lib/mutation'
import { deploymentsQuery } from '@/lib/queries'
import { isInFlight } from '@/lib/status'
import { warningAlert } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Started = SentOf<ReturnType<typeof api.v1.services>['redeploy']['post']>

function useDeploy<V = void>(
  service: Service,
  verb: (vars: V) => string,
  mutationFn: (vars: V) => Promise<Started>,
  options: {
    failure?: (vars: V) => string
    intercept?: (failure: unknown) => boolean
    onSuccess?: () => void
  } = {},
) {
  const navigate = useNavigate()
  return useApiMutation({
    mutationFn,
    invalidate: ['deployments'],
    staged: (vars) => ({
      title: `${verb(vars)} was staged for review`,
      description: 'This environment is protected; accept the change to start it.',
    }),
    success: (body, vars) => ({
      title: `${verb(vars)} started`,
      description: `${service.name} deployment #${body.number}`,
    }),
    onSuccess: (result) => {
      options.onSuccess?.()
      if (!result.staged)
        void navigate({
          to: '/deployments/$deployment',
          params: {
            deployment: result.body.id,
          },
        })
    },
    failure: options.failure,
    intercept: options.intercept,
  })
}

const useRedeploy = (service: Service, verb: string) =>
  useDeploy(
    service,
    () => verb,
    () =>
      send(
        api.v1
          .services({
            service: service.id,
          })
          .redeploy.post({}, idempotency()),
      ),
    {
      failure: () => `${verb} was refused`,
    },
  )

export function DeployButton({ service }: { service: Service }) {
  const [open, setOpen] = useState(false)
  const image = service.source.type === 'image' ? service.source.ref : null
  const [ref, setRef] = useState(image ?? '')
  const mutation = useDeploy(
    service,
    () => 'Deploy',
    () => {
      const body =
        service.source.type === 'image'
          ? {
              image: ref.trim(),
            }
          : ref.trim()
            ? {
                source_ref: ref.trim(),
              }
            : {}
      return send(
        api.v1
          .services({
            service: service.id,
          })
          .deployments.post(body, idempotency()),
      )
    },
    {
      onSuccess: () => setOpen(false),
    },
  )
  const repo = service.source.type === 'dockerfile' || service.source.type === 'railpack'
  if (service.source.type === 'local' || service.source.type === 'template') return null
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
      trigger={
        <Button size="sm">
          <Rocket /> Deploy
        </Button>
      }
      title={`Deploy ${service.name}`}
      description={
        repo
          ? 'Builds the source and rolls it out with the service strategy.'
          : 'Rolls out this image with the service strategy.'
      }
      error={mutation.errorText}
      submitLabel="Deploy"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="deploy-ref" label={repo ? 'Commit, branch or tag (optional)' : 'Image'}>
        <Input
          id="deploy-ref"
          required={!repo}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={
            repo && service.source.type !== 'image'
              ? (service.source as { branch: string }).branch
              : 'nginx:1.27'
          }
          className="font-mono"
        />
      </Field>
    </FormDialog>
  )
}

export function RedeployButton({ service }: { service: Service }) {
  const mutation = useRedeploy(service, 'Redeploy')
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => mutation.mutate()}
      disabled={!service.current_deployment_id || mutation.isPending}
    >
      {mutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Redeploy
    </Button>
  )
}

export function RollbackButton({
  service,
  deployment,
}: {
  service: Service
  deployment: Deployment
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const mutation = useDeploy(
    service,
    () => `Rollback to #${deployment.number}`,
    (stale: boolean) =>
      send(
        api.v1
          .services({
            service: service.id,
          })
          .rollback.post(
            {
              deployment_id: deployment.id,
              ...(stale
                ? {
                    confirm_stale_secrets: true,
                  }
                : {}),
            },
            idempotency(),
          ),
      ),
    {
      failure: () => 'Rollback was refused',
      intercept: (failure) => {
        if (!(failure instanceof ApiFailure && failure.code === 'STALE_SECRETS_CONFIRM_REQUIRED'))
          return false
        setConfirm(failure.message)
        return true
      },
    },
  )
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => mutation.mutate(false)}
        disabled={mutation.isPending}
        aria-label={`Roll back to deployment ${deployment.number}`}
      >
        {mutation.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />}
        Roll back
      </Button>
      <Confirm
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Roll back with older secret versions?"
        description={confirm}
        action="Roll back anyway"
        cancel="Cancel"
        destructive={false}
        renderError={() => null}
        onConfirm={() => mutation.mutateAsync(true)}
      />
    </>
  )
}

const staleTitle = (codes: Set<string>) =>
  codes.has('VARIABLES_CHANGED') && codes.has('CONFIG_CHANGED')
    ? 'Variables and configuration changed, deploy to apply'
    : codes.has('VARIABLES_CHANGED')
      ? 'Variables changed, deploy to apply'
      : 'Configuration changed, deploy to apply'

export function StaleBanner({ service }: { service: Service }) {
  const deployments = useQuery({
    ...deploymentsQuery(service.id),
    enabled: service.stale,
  })
  const mutation = useRedeploy(service, 'Deploy')
  const reasons = service.stale_reasons ?? []
  if (!service.stale || reasons.length === 0) return null
  const rolling = deployments.data?.items.find((d) => isInFlight(d.status))
  const sourceChanged = reasons.some(
    (r) => r.code === 'CONFIG_CHANGED' && r.keys.includes('source'),
  )
  return (
    <Alert
      role="status"
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        warningAlert,
      )}
      data-testid="stale-banner"
    >
      <div className="flex gap-2">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <div className="space-y-1">
          <AlertTitle>{staleTitle(new Set(reasons.map((r) => r.code)))}</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-100">
            {reasons.map((r) => (
              <p key={r.code} className="mb-0!">
                {r.explanation}
              </p>
            ))}
            {rolling && (
              <p className="mb-0!">
                Deployment #{rolling.number} is {rolling.status.replace('_', ' ')}; the banner
                clears when a deployment with these values is active.
              </p>
            )}
          </AlertDescription>
        </div>
      </div>
      {!rolling &&
        (sourceChanged ? (
          <DeployButton service={service} />
        ) : (
          <Button
            size="sm"
            className="shrink-0 self-start sm:self-center"
            onClick={() => mutation.mutate()}
            disabled={!service.current_deployment_id || mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
            Deploy
          </Button>
        ))}
    </Alert>
  )
}
