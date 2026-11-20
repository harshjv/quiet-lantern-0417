import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Eye, EyeOff, Lock, Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Code } from '@/components/code'
import { Confirm, RemoveButton } from '@/components/confirm'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { EmptyState, ErrorState } from '@/components/page'
import { Panel } from '@/components/panel'
import { Saving } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  VariableKindSelect,
  VariableNameInput,
  VariableNotes,
  VariableValueInput,
} from '@/components/variable-fields'
import { api, idempotency, send, unwrap, type Change, type EnvironmentVariable } from '@/lib/api'
import { editItems, isOptimistic } from '@/lib/cache'
import { record } from '@/lib/changes'
import { plural } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { injection as injectionLabel, variableKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  approvalsQuery,
  machineResolvedQuery,
  machineVariablesQuery,
  projectVariablesQuery,
  resolvedQuery,
  variablesQuery,
} from '@/lib/queries'
import { toneOutline } from '@/lib/tone'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'
import {
  hasNoValue,
  noValueLabel,
  projectReference,
  toMachineVariableInput,
  toVariableInput,
  withDraft,
  withoutVariables,
  type EnvironmentVariableKind,
  type VariableEntry,
} from '@/lib/variables'

export type VariableTarget =
  | { kind: 'app'; app: string }
  | { kind: 'project'; project: string; target: 'production' | 'preview' }
  | { kind: 'machine'; machine: string }

type Outcome =
  { waiting: true; body: { id: string } } | { waiting: false; body: { deployments: number } }

type Patch = { set?: VariableEntry[]; unset?: string[]; apply: boolean }

async function patchVariables(
  target: VariableTarget,
  { set, unset, apply }: Patch,
): Promise<Outcome> {
  if (target.kind === 'machine') {
    await unwrap(
      api.v1
        .machines({
          machine: target.machine,
        })
        ['environment-variables'].patch(
          {
            set: set?.map(toMachineVariableInput),
            unset,
          },
          idempotency(),
        ),
    )

    return {
      waiting: false,
      body: {
        deployments: 0,
      },
    }
  }

  const body = {
    set: set?.map(toVariableInput),
    unset,
    apply,
  }
  const result = await send(
    target.kind === 'app'
      ? api.v1
          .apps({
            app: target.app,
          })
          ['environment-variables'].patch(body, idempotency())
      : api.v1
          .projects({
            project: target.project,
          })
          ['environment-variables'].patch(
            {
              target: target.target,
              ...body,
            },
            idempotency(),
          ),
  )

  return result.waiting
    ? {
        waiting: true,
        body: {
          id: result.body.id,
        },
      }
    : {
        waiting: false,
        body: {
          deployments: result.body.deployments?.length ?? 0,
        },
      }
}

const listQuery = (target: VariableTarget) =>
  target.kind === 'app'
    ? variablesQuery(target.app)
    : target.kind === 'machine'
      ? machineVariablesQuery(target.machine)
      : projectVariablesQuery(target.project, target.target)

const drafts = (target: VariableTarget, { set = [], unset = [] }: Patch) => [
  editItems(listQuery(target), (list) =>
    withoutVariables(
      set.reduce((next, entry) => withDraft(next, entry, target.kind), list),
      unset,
    ),
  ),
]

const announce = (target: VariableTarget, verb: string, deployments: number) => {
  if (target.kind === 'machine') {
    return {
      title: verb,
      description:
        'Shells and commands use the new value now. The machine’s startup process gets it on next start.',
    }
  }

  return {
    title: verb,
    description: deployments
      ? `${plural(deployments, 'deployment')} started.`
      : 'Apps that use it pick it up on their next deploy.',
  }
}

function VariableDialog({
  target,
  existing,
  open,
  onOpenChange,
}: {
  target: VariableTarget
  existing: EnvironmentVariable | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<EnvironmentVariableKind>(existing?.kind ?? 'literal')
  const [value, setValue] = useState('')
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [injection, setInjection] = useState<'env' | 'file'>(existing?.injection ?? 'env')
  const [build, setBuild] = useState(existing?.build ?? false)
  const [apply, setApply] = useState(false)
  const [touched, setTouched] = useState(false)
  const loadsValue = existing?.kind === 'literal' && target.kind !== 'project'
  const appResolved = useQuery({
    ...resolvedQuery(target.kind === 'app' ? target.app : ''),
    enabled: loadsValue && target.kind === 'app',
  })
  const machineResolved = useQuery({
    ...machineResolvedQuery(target.kind === 'machine' ? target.machine : ''),
    enabled: loadsValue && target.kind === 'machine',
  })
  const current = loadsValue
    ? (target.kind === 'machine' ? machineResolved : appResolved).data?.environment_variables.find(
        (v) => v.environment_variable_id === existing?.id,
      )?.value
    : undefined

  useEffect(() => {
    if (current !== undefined && !touched) {
      setValue(current)
    }
  }, [current, touched])
  const verb = existing ? `${name} updated` : `${name} added`
  const mutation = useApiMutation({
    mutationFn: (entry: VariableEntry) =>
      patchVariables(target, {
        set: [entry],
        apply,
      }),
    optimistic: (entry) =>
      drafts(target, {
        set: [entry],
        apply,
      }),
    invalidate: ['environment-variables'],
    waiting: () => `${existing ? 'Change' : 'Add'} ${name.trim()}`,
    success: (body) => announce(target, verb, body.deployments),
    onSuccess: () => {
      setValue('')
      onOpenChange(false)
    },
  })
  const isReference = kind === 'reference'

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setValue('')
        }

        onOpenChange(next)
      }}
      title={existing ? `Change ${existing.name}` : 'Add an environment variable'}
      description={
        <>
          {target.kind === 'project' ? (
            <>
              No app inherits it: an app reads it through a reference such as{' '}
              <Code>{projectReference}</Code>.
            </>
          ) : target.kind === 'machine' ? (
            'Reference a project or global environment variable to keep a credential out of an agent’s reach.'
          ) : (
            'Reaches this app as a variable or a file.'
          )}{' '}
          {target.kind === 'machine'
            ? 'Each save creates a new version.'
            : 'Each save creates a new version. Running deployments keep the one they started with.'}
        </>
      }
      error={mutation.errorText}
      submitLabel="Save"
      pending={mutation.isPending}
      hideWhilePending
      onSubmit={() =>
        mutation.mutate({
          name: name.trim(),
          kind,
          value: isReference ? reference : value,
          injection,
          build,
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field id="variable-name" label="Name">
          <VariableNameInput
            id="variable-name"
            value={name}
            onValueChange={setName}
            disabled={Boolean(existing)}
          />
        </Field>
        <Field id="variable-kind" label="Kind">
          <VariableKindSelect id="variable-kind" value={kind} onValueChange={setKind} />
        </Field>
      </div>
      <Field id="variable-value" label={isReference ? 'Reference' : 'Value'}>
        <VariableValueInput
          id="variable-value"
          kind={kind}
          multiline
          value={isReference ? reference : value}
          onValueChange={(next) => {
            if (isReference) {
              return setReference(next)
            }

            setTouched(true)
            setValue(next)
          }}
          placeholder={
            existing?.kind === 'literal' && current === undefined
              ? 'Enter the new value'
              : undefined
          }
        />
      </Field>
      {target.kind !== 'machine' && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="variable-injection" className="font-normal">
              Injected as
            </Label>
            <Select value={injection} onValueChange={(v) => setInjection(v as 'env' | 'file')}>
              <SelectTrigger id="variable-injection" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="env">{injectionLabel.env}</SelectItem>
                <SelectItem value="file">{injectionLabel.file}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CheckboxField
            id="variable-build"
            checked={build}
            onCheckedChange={setBuild}
            label="Available at build time"
          />
          <CheckboxField
            id="variable-apply"
            checked={apply}
            onCheckedChange={setApply}
            label="Redeploy dependents now"
          />
        </div>
      )}
      <VariableNotes secret={kind === 'secret'} build={target.kind !== 'machine' && build} />
    </FormDialog>
  )
}

function RemoveVariable({ target, item }: { target: VariableTarget; item: EnvironmentVariable }) {
  const mutation = useApiMutation({
    mutationFn: () =>
      patchVariables(target, {
        unset: [item.name],
        apply: false,
      }),
    optimistic: () =>
      drafts(target, {
        unset: [item.name],
        apply: false,
      }),
    invalidate: ['environment-variables'],
    waiting: () => `Remove ${item.name}`,
    success: (body) => announce(target, `${item.name} removed`, body.deployments),
  })

  return (
    <Confirm
      title={`Remove ${item.name}?`}
      description="Apps that use it lose it on their next deployment. Stationly keeps it while another environment variable references it."
      action="Remove environment variable"
      cancel="Keep environment variable"
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${item.name}`} disabled={isOptimistic(item)} />}
    />
  )
}

function ValueCell({
  item,
  revealed,
  onSet,
}: {
  item: EnvironmentVariable
  revealed: string | undefined
  onSet: () => void
}) {
  if (isOptimistic(item)) {
    return <Saving />
  }

  if (hasNoValue(item)) {
    return (
      <span className="inline-flex items-center gap-2 text-muted-foreground" data-secret="true">
        <Lock className="size-3.5" aria-hidden />
        {noValueLabel}
        <Button size="xs" variant="outline" onClick={onSet}>
          Set a value
        </Button>
      </span>
    )
  }

  if (item.kind === 'secret') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-secret="true">
        <Lock className="size-3.5" aria-hidden />
        {`Hidden · ${item.bytes} bytes · version ${item.head_version}`}
      </span>
    )
  }

  if (item.kind === 'reference') {
    return <Code>{item.reference}</Code>
  }

  if (revealed !== undefined) {
    return <Code>{revealed}</Code>
  }

  return (
    <span className="text-muted-foreground">
      {item.head_version ? `Hidden · version ${item.head_version}` : 'Not set'}
    </span>
  )
}

const headVersion = (item: EnvironmentVariable) => String(item.head_version)

type Pending = {
  approval: string
  op: Change['op']
  name: string
  kind: EnvironmentVariableKind | null
}

function usePendingVariables(target: VariableTarget, items: EnvironmentVariable[]) {
  const waiting = useQuery({
    ...approvalsQuery('waiting'),
    enabled: target.kind !== 'machine',
  })
  const parent =
    target.kind === 'app' ? target.app : target.kind === 'project' ? target.project : null
  const ids = new Set(items.map((item) => item.id))
  const pending = (waiting.data?.items ?? []).flatMap((approval) =>
    (approval.changes ?? []).flatMap((change): Pending[] => {
      const data = record(change.op === 'remove' ? change.before : change.after) ?? {}
      const name = typeof data.name === 'string' ? data.name : null
      const ours =
        change.entity === 'environment_variable' &&
        name !== null &&
        (change.op === 'add'
          ? change.parent === parent && (target.kind !== 'project' || data.target === target.target)
          : ids.has(change.id ?? ''))

      return ours
        ? [
            {
              approval: approval.id,
              op: change.op,
              name,
              kind: (data.kind as EnvironmentVariableKind | undefined) ?? null,
            },
          ]
        : []
    }),
  )

  return {
    adds: pending.filter((p) => p.op === 'add' && !items.some((item) => item.name === p.name)),
    of: (item: EnvironmentVariable) => pending.find((p) => p.op !== 'add' && p.name === item.name),
  }
}

const pendingText: Record<Change['op'], string> = {
  add: 'Waits for approval',
  update: 'Change waits for approval',
  remove: 'Removal waits for approval',
}

function PendingBadge({ pending }: { pending: Pending | undefined }) {
  if (!pending) {
    return null
  }

  return (
    <Badge asChild variant="outline" className={cn('ml-2 font-normal', toneOutline.warning)}>
      <Link
        to="/approvals/$approval"
        params={{
          approval: pending.approval,
        }}
      >
        {pendingText[pending.op]}
      </Link>
    </Badge>
  )
}

function VariableRows({
  target,
  values,
  onEdit,
  onAdd,
  also,
}: {
  target: VariableTarget
  values: Map<string, string>
  onEdit: (item: EnvironmentVariable) => void
  onAdd: () => void
  also?: ReactNode
}) {
  const { data } = useSuspenseQuery(listQuery(target))
  const items = [...data.items].sort((a, b) => a.name.localeCompare(b.name))
  const visible = items
  const fresh = useFresh(visible, headVersion)
  const pending = usePendingVariables(target, items)

  if (visible.length === 0 && pending.adds.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.environment_variable}
        title="No environment variables yet"
        description={
          target.kind === 'machine' ? (
            'They reach this machine’s shells and processes. Mark the ones that hold secrets as secret.'
          ) : target.kind === 'project' ? (
            <>
              A project environment variable reaches no app by itself. Give an app one that
              references it, such as <Code>{projectReference}</Code>. Mark the ones that hold
              secrets as secret.
            </>
          ) : (
            'They reach this app when it deploys. Mark the ones that hold secrets as secret.'
          )
        }
        action={
          <Button size="sm" onClick={onAdd}>
            <Plus /> Add environment variable
          </Button>
        }
        also={also}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[28%]">Name</TableHead>
          <TableHead className="w-24">Kind</TableHead>
          <TableHead>Value</TableHead>
          {target.kind !== 'machine' && (
            <TableHead className="hidden w-36 md:table-cell">Injection</TableHead>
          )}
          <ActionsHead className="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((item) => (
          <TableRow key={item.id} className={cn(fresh.has(item.id) && highlight)}>
            <TableCell>
              <span className="font-mono text-[0.8125rem] font-medium">{item.name}</span>
              <PendingBadge pending={pending.of(item)} />
              {target.kind === 'project' &&
                target.target === 'preview' &&
                !(item.targets ?? []).includes('preview') && (
                  <Badge variant="outline" className="ml-2 text-muted-foreground">
                    {item.kind === 'secret' ? 'No preview value' : 'Production value'}
                  </Badge>
                )}
            </TableCell>
            <TableCell>
              <Badge variant={item.kind === 'secret' ? 'secondary' : 'outline'}>
                {variableKind[item.kind]}
              </Badge>
            </TableCell>
            <TableCell className="max-w-0 whitespace-normal">
              <ValueCell item={item} revealed={values.get(item.id)} onSet={() => onEdit(item)} />
            </TableCell>
            {target.kind !== 'machine' && (
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {injectionLabel[item.injection]}
                {item.build && ' · also at build'}
              </TableCell>
            )}
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Change ${item.name}`}
                disabled={isOptimistic(item)}
                onClick={() => onEdit(item)}
              >
                <Pencil />
              </Button>
              <RemoveVariable target={target} item={item} />
            </TableCell>
          </TableRow>
        ))}
        {pending.adds.map((entry) => (
          <TableRow
            key={`pending:${entry.approval}:${entry.name}`}
            className="text-muted-foreground"
          >
            <TableCell>
              <span className="font-mono text-[0.8125rem] font-medium text-foreground">
                {entry.name}
              </span>
              <PendingBadge pending={entry} />
            </TableCell>
            <TableCell>
              {entry.kind && <Badge variant="outline">{variableKind[entry.kind]}</Badge>}
            </TableCell>
            <TableCell className="whitespace-normal">
              Stationly adds it once an admin approves.
            </TableCell>
            {target.kind !== 'machine' && <TableCell className="hidden md:table-cell" />}
            <TableCell />
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

export function VariablesPanel({ target, also }: { target: VariableTarget; also?: ReactNode }) {
  const [reveal, setReveal] = useState(false)
  const appResolved = useQuery({
    ...resolvedQuery(target.kind === 'app' ? target.app : ''),
    enabled: reveal && target.kind === 'app',
  })
  const machineResolved = useQuery({
    ...machineResolvedQuery(target.kind === 'machine' ? target.machine : ''),
    enabled: reveal && target.kind === 'machine',
  })
  const resolved = target.kind === 'machine' ? machineResolved : appResolved
  const [editing, setEditing] = useState<EnvironmentVariable | null>(null)
  const [adding, setAdding] = useState(false)
  const values = new Map(
    (resolved.data?.environment_variables ?? [])
      .filter((v) => !v.secret && v.value !== undefined)
      .map((v) => [v.environment_variable_id, v.value!]),
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {target.kind === 'app' ? (
            'Environment variables of this app. Stationly resolves references when it deploys.'
          ) : target.kind === 'machine' ? (
            'Environment variables of this machine. Stationly resolves references when the machine starts and when a value changes.'
          ) : target.target === 'production' ? (
            <>
              Environment variables of this project’s production. Nothing is inherited: an app reads
              one through a reference such as <Code>{projectReference}</Code>.
            </>
          ) : (
            <>
              Preview values of this project’s environment variables, read through references such
              as <Code>{projectReference}</Code> from apps in every preview. A visible one without a
              preview value reads its production value; production’s secret values never reach a
              preview.
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {target.kind !== 'project' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReveal((r) => !r)}
              aria-pressed={reveal}
            >
              {reveal ? <EyeOff /> : <Eye />}
              {reveal ? 'Hide values' : 'Show visible values'}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add environment variable
          </Button>
        </div>
      </div>
      {reveal && (
        <p className="text-xs text-muted-foreground">
          Stationly records each read of these values in the audit log. Secret values stay hidden.
        </p>
      )}
      {resolved.isError && <ErrorState error={resolved.error} title="Couldn’t load values" />}
      <Panel title="Couldn’t load environment variables">
        <VariableRows
          target={target}
          values={values}
          onEdit={setEditing}
          onAdd={() => setAdding(true)}
          also={also}
        />
      </Panel>
      {adding && (
        <VariableDialog target={target} existing={null} open={adding} onOpenChange={setAdding} />
      )}
      {editing && (
        <VariableDialog
          key={editing.id}
          target={target}
          existing={editing}
          open={Boolean(editing)}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </div>
  )
}
