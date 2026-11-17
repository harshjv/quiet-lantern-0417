import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle } from 'lucide-react'
import { useState } from 'react'

import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Mono } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, idempotency, send, type Inventory, type Station } from '@/lib/api'
import { plural } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { releasesQuery } from '@/lib/queries'
import type { Tone } from '@/lib/tone'

import { Checklist, Notice, StatusPill, type Step } from './parts'

type Upgrade = NonNullable<Inventory['upgrade']>

type UpgradeReply = Awaited<ReturnType<typeof api.v1.platform.upgrade.post>>['data']

type Plan = Extract<NonNullable<UpgradeReply>, { release: { manifest_digest: string } }>

const upgradeStatus: Record<Upgrade['status'], { label: string; tone: Tone }> = {
  running: {
    label: 'Upgrading',
    tone: 'warning',
  },
  reverting: {
    label: 'Reverting',
    tone: 'warning',
  },
  done: {
    label: 'Done',
    tone: 'success',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
  },
  reverted: {
    label: 'Reverted',
    tone: 'neutral',
  },
}

const stepState: Record<Upgrade['steps'][number]['status'], Step['state']> = {
  pending: 'todo',
  running: 'now',
  reverting: 'now',
  done: 'done',
  failed: 'failed',
  reverted: 'failed',
  revert_failed: 'failed',
}

export const upgradeActive = (upgrade: Inventory['upgrade'] | undefined) =>
  upgrade?.status === 'running' || upgrade?.status === 'reverting'

const versionOf = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object' && 'version' in value) {
    return typeof value.version === 'string' ? value.version : null
  }

  return null
}

const cleanVersion = (text: string) => text.trim().replace(/^v/, '')

const isPlan = (body: UpgradeReply): body is Plan =>
  !!body &&
  'release' in body &&
  typeof body.release === 'object' &&
  'manifest_digest' in body.release

export function UpgradeProgress({
  upgrade,
  stations,
}: {
  upgrade: Upgrade
  stations: Pick<Station, 'id' | 'name'>[]
}) {
  const status = upgradeStatus[upgrade.status]
  const serverName = (id: string | null) =>
    id === null ? 'the instance' : (stations.find((s) => s.id === id)?.name ?? id)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">
          Upgrade from v{upgrade.release.from} to v{upgrade.release.to}
        </span>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      {upgrade.failure && (
        <Notice tone="danger" title={upgrade.failure.explanation}>
          {upgrade.failure.fix}
        </Notice>
      )}
      {upgrade.steps.length > 0 && (
        <Checklist
          steps={upgrade.steps.map((step) => ({
            label: `${step.component} on ${serverName(step.server)}, ${step.from.version} to ${step.to.version}`,
            state: stepState[step.status],
          }))}
        />
      )}
    </div>
  )
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        From <Mono>v{plan.release.from}</Mono> to <Mono>v{plan.release.to}</Mono>,{' '}
        {plural(plan.changes.length, 'change')}.
      </p>
      {plan.changes.length > 0 && (
        <ol className="flex flex-col gap-1 border p-3">
          {plan.changes.map((change) => (
            <li key={`${change.order}-${change.component}-${change.server}`} className="flex gap-2">
              <span className="w-5 shrink-0 text-muted-foreground tabular-nums">
                {change.order}
              </span>
              <span className="min-w-0 flex-1">
                <Mono>{change.component}</Mono> {change.from.version} to {change.to.version}
                <span className="block text-xs text-muted-foreground">{change.procedure}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {plan.release.removed_overrides.length > 0 && (
        <p className="text-muted-foreground">
          Drops the overrides for {plan.release.removed_overrides.join(', ')}.
        </p>
      )}
      {plan.release.changelog && (
        <pre className="max-h-48 overflow-auto border bg-muted p-3 text-xs whitespace-pre-wrap">
          {plan.release.changelog}
        </pre>
      )}
    </div>
  )
}

function UpgradeDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const { data: releases } = useQuery(releasesQuery)
  const offered = (releases?.available ?? []).map(versionOf).filter((v) => v !== null)
  const [version, setVersion] = useState(offered[0] ?? '')
  const [plan, setPlan] = useState<Plan | null>(null)
  const refresh = () =>
    void client.invalidateQueries({
      queryKey: ['inventory'],
    })
  const check = useApiMutation({
    mutationFn: (wanted: string) =>
      send(
        api.v1.platform.upgrade.post({
          version: wanted,
          plan: true,
        }),
      ),
    onSuccess: (result) => {
      if (!result.waiting && isPlan(result.body)) {
        setPlan(result.body)
      }
    },
  })
  const apply = useApiMutation({
    mutationFn: (wanted: string) =>
      send(
        api.v1.platform.upgrade.post(
          {
            version: wanted,
            plan: false,
          },
          idempotency(),
        ),
      ),
    invalidate: ['stations'],
    waiting: (wanted) => `The upgrade to v${wanted}`,
    success: (body, wanted) =>
      body.id === null
        ? `Stationly already runs v${wanted}`
        : {
            title: `Upgrading to v${wanted}`,
            description: 'Each component restarts in turn. Follow it in the Release section.',
          },
    onSuccess: () => {
      refresh()
      onOpenChange(false)
    },
  })
  const wanted = cleanVersion(version)

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      size="lg"
      title={plan ? `Upgrade to v${plan.release.to}` : 'Upgrade Stationly'}
      description={
        plan
          ? 'Every server checked the release signature. Stationly takes a backup first and reverts a step that fails.'
          : 'Name a published release. Stationly checks its signature on every server and shows the plan before anything changes.'
      }
      error={check.errorText ?? apply.errorText}
      submitLabel={plan ? `Upgrade to v${plan.release.to}` : 'Check release'}
      pending={check.isPending || apply.isPending}
      onSubmit={() => (plan ? apply.mutate(plan.release.to) : check.mutate(wanted))}
    >
      {plan ? (
        <>
          <PlanView plan={plan} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setPlan(null)}
          >
            Pick another version
          </Button>
        </>
      ) : (
        <Field
          id="upgrade-version"
          label="Version"
          hint={
            offered.length > 0
              ? undefined
              : releases && !releases.enabled
                ? 'Release checks are off, so type the version from the release notes.'
                : 'Type the version from the release notes, such as 0.1.4.'
          }
        >
          <Input
            id="upgrade-version"
            required
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="0.1.4"
            className="font-mono"
          />
          {offered.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {offered.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="xs"
                  variant={wanted === option ? 'secondary' : 'outline'}
                  onClick={() => setVersion(option)}
                >
                  v{option}
                </Button>
              ))}
            </div>
          )}
        </Field>
      )}
    </FormDialog>
  )
}

export function UpgradeButton({
  current,
  upgrade,
}: {
  current: string | null
  upgrade: Inventory['upgrade'] | null
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={current === null || upgradeActive(upgrade)}
        title={current === null ? 'Install a release first' : undefined}
        onClick={() => setOpen(true)}
      >
        <ArrowUpCircle /> Upgrade
      </Button>
      {open && <UpgradeDialog onOpenChange={setOpen} />}
    </>
  )
}
