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
import { deploymentsQuery, seedDeployment } from '@/lib/queries'
import { isInFlight } from '@/lib/status'
import { warningAlert } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Started = SentOf<ReturnType<typeof api.v1.services>['redeploy']['post']>

function useDeploy<V = void>(
  act: (vars: V) => { started: string; staged: string; failed: string },
  mutationFn: (vars: V) => Promise<Started>,
  options: {
    inline?: boolean
    intercept?: (failure: unknown) => boolean
    onSuccess?: () => void
  } = {},
) {
  const navigate = useNavigate()
  return useApiMutation({
    mutationFn,
    seed: seedDeployment,
    invalidate: ['deployments'],
    staged: (vars) => act(vars).staged,
    success: (body, vars) => ({
      title: act(vars).started,
      description: `Deployment #${body.number}`,
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
    failure: options.inline ? undefined : (vars) => act(vars).failed,
    intercept: options.intercept,
  })
}

const useRedeploy = (service: Service, verb: 'Deploy' | 'Redeploy') =>
  useDeploy(
    () =>
      verb === 'Redeploy'
        ? {
            started: `Redeploying ${service.name}`,
            staged: `Redeploy ${service.name}`,
            failed: `redeploy ${service.name}`,
          }
        : {
            started: `Deploying ${service.name}`,
            staged: `Deploy ${service.name}`,
            failed: `deploy ${service.name}`,
          },
    () =>
      send(
        api.v1
          .services({
            service: service.id,
          })
          .redeploy.post({}, idempotency()),
      ),
  )

export function DeployButton({ service }: { service: Service }) {
  const [open, setOpen] = useState(false)
  const image = service.source.type === 'image' ? service.source.ref : null
  const [ref, setRef] = useState(image ?? '')
  const mutation = useDeploy(
    () => ({
      started: `Deploying ${service.name}`,
      staged: `Deploy ${service.name}`,
      failed: `deploy ${service.name}`,
    }),
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
      inline: true,
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
          ? `Stationly builds the source and rolls it out to ${service.name}.`
          : `Stationly rolls this image out to ${service.name}.`
      }
      error={mutation.errorText}
      submitLabel={`Deploy ${service.name}`}
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
    () => ({
      started: `Rolling back to #${deployment.number}`,
      staged: `Roll ${service.name} back to #${deployment.number}`,
      failed: `roll back to #${deployment.number}`,
    }),
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
    ? 'Variables and settings changed. Deploy to use them.'
    : codes.has('VARIABLES_CHANGED')
      ? 'Variables changed. Deploy to use them.'
      : 'Settings changed. Deploy to use them.'

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
                Deployment #{rolling.number} is rolling out. This notice goes away when it’s active.
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
