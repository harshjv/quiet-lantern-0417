import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, TriangleAlert, Undo2 } from 'lucide-react'
import { useState } from 'react'

import { CodeInput } from '@/components/code'
import { Confirm } from '@/components/confirm'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  api,
  ApiFailure,
  idempotency,
  send,
  type App,
  type Deployment,
  type SentOf,
} from '@/lib/api'
import { editItems } from '@/lib/cache'
import { entityIcon } from '@/lib/icons'
import { follow } from '@/lib/live'
import { useApiMutation } from '@/lib/mutation'
import { deploymentsQuery, seedDeployment } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { isInFlight, withQueued, type TriggerType } from '@/lib/status'
import { warningAlert } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Started = SentOf<ReturnType<typeof api.v1.apps>['redeploy']['post']>

type Named = Pick<App, 'id' | 'name'>

export function useDeploy<V = void>(
  target: { app: string; trigger: TriggerType },
  act: (vars: V) => { started: string; waiting: string; failed: string },
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
    optimistic: () => [
      editItems(deploymentsQuery(target.app), (list) => withQueued(list, target.trigger)),
    ],
    seed: seedDeployment,
    invalidate: ['deployments'],
    waiting: (vars) => act(vars).waiting,
    success: (body, vars) => ({
      title: act(vars).started,
      description: `Deployment #${body.number}`,
    }),
    onSuccess: (result) => {
      options.onSuccess?.()

      if (result.waiting) {
        return
      }

      follow(result.body.id)
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

export const deployCopy = (name: string) => ({
  started: `Deploying ${name}`,
  waiting: `Deploy ${name}`,
  failed: `deploy ${name}`,
})

const useRedeploy = (app: Named, verb: 'Deploy' | 'Redeploy') =>
  useDeploy(
    {
      app: app.id,
      trigger: 'redeploy',
    },
    () =>
      verb === 'Redeploy'
        ? {
            started: `Redeploying ${app.name}`,
            waiting: `Redeploy ${app.name}`,
            failed: `redeploy ${app.name}`,
          }
        : deployCopy(app.name),
    () =>
      send(
        api.v1
          .apps({
            app: app.id,
          })
          .redeploy.post({}, idempotency()),
      ),
  )

export function DeployButton({ app, shortcut }: { app: App; shortcut?: boolean }) {
  const [open, setOpen] = useState(false)
  const deployable = app.source.type !== 'local' && app.source.type !== 'template'

  useShortcut('deploy', () => setOpen(true), Boolean(shortcut) && deployable)
  const image = app.source.type === 'image' ? app.source.ref : null
  const [ref, setRef] = useState(image ?? '')
  const mutation = useDeploy(
    {
      app: app.id,
      trigger: 'manual',
    },
    () => deployCopy(app.name),
    () => {
      const body =
        app.source.type === 'image'
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
          .apps({
            app: app.id,
          })
          .deployments.post(body, idempotency()),
      )
    },
    {
      inline: true,
      onSuccess: () => setOpen(false),
    },
  )
  const repo = app.source.type === 'dockerfile' || app.source.type === 'railpack'

  if (!deployable) {
    return null
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          mutation.reset()
        }
      }}
      trigger={
        <Button size="sm">
          <entityIcon.deployment /> Deploy
        </Button>
      }
      title={`Deploy ${app.name}`}
      error={mutation.errorText}
      submitLabel={`Deploy ${app.name}`}
      pending={mutation.isPending}
      hideWhilePending
      onSubmit={() => mutation.mutate()}
    >
      <Field id="deploy-ref" label={repo ? 'Commit, branch or tag (optional)' : 'Image'}>
        <CodeInput
          id="deploy-ref"
          required={!repo}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={
            repo && app.source.type !== 'image'
              ? (app.source as { branch: string }).branch
              : 'nginx:1.27'
          }
        />
      </Field>
    </FormDialog>
  )
}

export function useRollback(app: Named, deployment: { id: string; label: string }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const mutation = useDeploy(
    {
      app: app.id,
      trigger: 'rollback',
    },
    () => ({
      started: `Rolling back to ${deployment.label}`,
      waiting: `Roll ${app.name} back to ${deployment.label}`,
      failed: `roll back to ${deployment.label}`,
    }),
    (stale: boolean) =>
      send(
        api.v1
          .apps({
            app: app.id,
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
        if (!(failure instanceof ApiFailure && failure.code === 'STALE_SECRETS_CONFIRM_REQUIRED')) {
          return false
        }

        setConfirm(failure.message)

        return true
      },
    },
  )

  return {
    mutation,
    confirm: (
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
    ),
  }
}

export function RollbackButton({ app, deployment }: { app: App; deployment: Deployment }) {
  const { mutation, confirm } = useRollback(app, {
    id: deployment.id,
    label: `#${deployment.number}`,
  })

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
      {confirm}
    </>
  )
}

const staleTitle = (codes: Set<string>) =>
  codes.has('ENVIRONMENT_VARIABLES_CHANGED') && codes.has('CONFIG_CHANGED')
    ? 'Environment variables and settings changed. Deploy to use them.'
    : codes.has('ENVIRONMENT_VARIABLES_CHANGED')
      ? 'Environment variables changed. Deploy to use them.'
      : 'Settings changed. Deploy to use them.'

export function StaleBanner({ app }: { app: App }) {
  const deployments = useQuery({
    ...deploymentsQuery(app.id),
    enabled: app.stale,
  })
  const mutation = useRedeploy(app, 'Deploy')
  const reasons = app.stale_reasons ?? []

  if (!app.stale || reasons.length === 0) {
    return null
  }

  const rolling = deployments.data?.items.find((d) => isInFlight(d.status))
  const sourceChanged = reasons.some(
    (r) => r.code === 'CONFIG_CHANGED' && r.names.includes('source'),
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
            {rolling && <p className="mb-0!">Deployment #{rolling.number} rolling out</p>}
          </AlertDescription>
        </div>
      </div>
      {!rolling &&
        (sourceChanged ? (
          <DeployButton app={app} />
        ) : (
          <Button
            size="sm"
            className="shrink-0 self-start sm:self-center"
            onClick={() => mutation.mutate()}
            disabled={!app.current_deployment_id || mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <entityIcon.deployment />}
            Deploy
          </Button>
        ))}
    </Alert>
  )
}
