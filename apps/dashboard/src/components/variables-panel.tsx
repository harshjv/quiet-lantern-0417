import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
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
import { KeyKindSelect, KeyNameInput, KeyNotes, KeyValueInput } from '@/components/variable-fields'
import { api, idempotency, send, unwrap, type Key } from '@/lib/api'
import { editItems, isOptimistic } from '@/lib/cache'
import { plural } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { injection as injectionLabel, keyKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  keysQuery,
  machineKeysQuery,
  machineResolvedQuery,
  projectKeysQuery,
  resolvedQuery,
} from '@/lib/queries'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'
import {
  hasNoValue,
  noValueLabel,
  toKeyInput,
  toMachineKeyInput,
  withDraft,
  withoutKeys,
  type KeyEntry,
  type KeyKind,
} from '@/lib/variables'

const targetLabel = {
  production: 'production',
  preview: 'every preview',
} as const

export type KeyTarget =
  | { kind: 'app'; app: string }
  | { kind: 'project'; project: string; target: 'production' | 'preview' }
  | { kind: 'machine'; machine: string }

type Outcome =
  { waiting: true; body: { id: string } } | { waiting: false; body: { deployments: number } }

type Patch = { set?: KeyEntry[]; unset?: string[]; apply: boolean }

async function patchKeys(target: KeyTarget, { set, unset, apply }: Patch): Promise<Outcome> {
  if (target.kind === 'machine') {
    await unwrap(
      api.v1
        .machines({
          machine: target.machine,
        })
        .keys.patch(
          {
            set: set?.map(toMachineKeyInput),
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
    set: set?.map(toKeyInput),
    unset,
    apply,
  }
  const result = await send(
    target.kind === 'app'
      ? api.v1
          .apps({
            app: target.app,
          })
          .keys.patch(body, idempotency())
      : api.v1
          .projects({
            project: target.project,
          })
          .keys.patch(
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

const listQuery = (target: KeyTarget) =>
  target.kind === 'app'
    ? keysQuery(target.app)
    : target.kind === 'machine'
      ? machineKeysQuery(target.machine)
      : projectKeysQuery(target.project, target.target)

const drafts = (target: KeyTarget, { set = [], unset = [] }: Patch) => [
  editItems(listQuery(target), (list) =>
    withoutKeys(
      set.reduce((next, entry) => withDraft(next, entry, target.kind), list),
      unset,
    ),
  ),
]

const announce = (target: KeyTarget, verb: string, deployments: number) => {
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

function KeyDialog({
  target,
  existing,
  open,
  onOpenChange,
}: {
  target: KeyTarget
  existing: Key | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<KeyKind>(existing?.kind ?? 'literal')
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
    ? (target.kind === 'machine' ? machineResolved : appResolved).data?.keys.find(
        (v) => v.key_id === existing?.id,
      )?.value
    : undefined

  useEffect(() => {
    if (current !== undefined && !touched) {
      setValue(current)
    }
  }, [current, touched])
  const verb = existing ? `${name} updated` : `${name} added`
  const mutation = useApiMutation({
    mutationFn: (entry: KeyEntry) =>
      patchKeys(target, {
        set: [entry],
        apply,
      }),
    optimistic: (entry) =>
      drafts(target, {
        set: [entry],
        apply,
      }),
    invalidate: ['keys'],
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
      title={existing ? `Change ${existing.name}` : 'Add a key'}
      description={
        <>
          {target.kind === 'project'
            ? `Shared by every app in ${targetLabel[target.target]}.`
            : target.kind === 'machine'
              ? 'Reference a project or global key to keep a credential out of an agent’s reach.'
              : 'Reaches this app as an environment variable or a file.'}{' '}
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
        <Field id="key-name" label="Name">
          <KeyNameInput
            id="key-name"
            value={name}
            onValueChange={setName}
            disabled={Boolean(existing)}
          />
        </Field>
        <Field id="key-kind" label="Kind">
          <KeyKindSelect id="key-kind" value={kind} onValueChange={setKind} />
        </Field>
      </div>
      <Field id="key-value" label={isReference ? 'Reference' : 'Value'}>
        <KeyValueInput
          id="key-value"
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
            <Label htmlFor="key-injection" className="font-normal">
              Injected as
            </Label>
            <Select value={injection} onValueChange={(v) => setInjection(v as 'env' | 'file')}>
              <SelectTrigger id="key-injection" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="env">{injectionLabel.env}</SelectItem>
                <SelectItem value="file">{injectionLabel.file}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CheckboxField
            id="key-build"
            checked={build}
            onCheckedChange={setBuild}
            label="Available at build time"
          />
          <CheckboxField
            id="key-apply"
            checked={apply}
            onCheckedChange={setApply}
            label="Redeploy dependents now"
          />
        </div>
      )}
      <KeyNotes sealed={kind === 'sealed'} build={target.kind !== 'machine' && build} />
    </FormDialog>
  )
}

function RemoveKey({ target, item }: { target: KeyTarget; item: Key }) {
  const mutation = useApiMutation({
    mutationFn: () =>
      patchKeys(target, {
        unset: [item.name],
        apply: false,
      }),
    optimistic: () =>
      drafts(target, {
        unset: [item.name],
        apply: false,
      }),
    invalidate: ['keys'],
    waiting: () => `Remove ${item.name}`,
    success: (body) => announce(target, `${item.name} removed`, body.deployments),
  })

  return (
    <Confirm
      title={`Remove ${item.name}?`}
      description="Apps that use it lose it on their next deployment. Stationly keeps it while another key references it."
      action="Remove key"
      cancel="Keep key"
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
  item: Key
  revealed: string | undefined
  onSet: () => void
}) {
  if (isOptimistic(item)) {
    return <Saving />
  }

  if (hasNoValue(item)) {
    return (
      <span className="inline-flex items-center gap-2 text-muted-foreground" data-sealed="true">
        <Lock className="size-3.5" aria-hidden />
        {noValueLabel}
        <Button size="xs" variant="outline" onClick={onSet}>
          Set a value
        </Button>
      </span>
    )
  }

  if (item.kind === 'sealed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-sealed="true">
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

const headVersion = (item: Key) => String(item.head_version)

function KeyRows({
  target,
  values,
  onEdit,
  onAdd,
  also,
}: {
  target: KeyTarget
  values: Map<string, string>
  onEdit: (item: Key) => void
  onAdd: () => void
  also?: ReactNode
}) {
  const { data } = useSuspenseQuery(listQuery(target))
  const items = [...data.items].sort((a, b) => a.name.localeCompare(b.name))
  const visible = items
  const fresh = useFresh(visible, headVersion)

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.key}
        title="No keys yet"
        description={
          target.kind === 'machine'
            ? 'Keys reach this machine as environment variables. Seal the ones that hold secrets.'
            : target.kind === 'project'
              ? `Shared keys reach every app in ${targetLabel[target.target]}. Seal the ones that hold secrets.`
              : 'Keys reach this app as environment variables. Seal the ones that hold secrets.'
        }
        action={
          <Button size="sm" onClick={onAdd}>
            <Plus /> Add key
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
          <TableHead className="w-[28%]">Key</TableHead>
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
              {target.kind === 'project' &&
                target.target === 'preview' &&
                !(item.targets ?? []).includes('preview') && (
                  <Badge variant="outline" className="ml-2 text-muted-foreground">
                    {item.kind === 'sealed' ? 'No preview value' : 'Production value'}
                  </Badge>
                )}
            </TableCell>
            <TableCell>
              <Badge variant={item.kind === 'sealed' ? 'secondary' : 'outline'}>
                {keyKind[item.kind]}
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
              <RemoveKey target={target} item={item} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

export function KeysPanel({ target, also }: { target: KeyTarget; also?: ReactNode }) {
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
  const [editing, setEditing] = useState<Key | null>(null)
  const [adding, setAdding] = useState(false)
  const values = new Map(
    (resolved.data?.keys ?? [])
      .filter((v) => !v.sealed && v.value !== undefined)
      .map((v) => [v.key_id, v.value!]),
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {target.kind === 'app'
            ? 'Keys of this app. Stationly resolves references when it deploys.'
            : target.kind === 'machine'
              ? 'Keys of this machine. Stationly resolves references when the machine starts and when a value changes.'
              : target.target === 'production'
                ? 'Shared keys for every app in production.'
                : 'Shared keys for every preview. A literal key without a preview value reads its production value; production’s sealed values never reach a preview.'}
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
              {reveal ? 'Hide values' : 'Show plain values'}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add key
          </Button>
        </div>
      </div>
      {reveal && (
        <p className="text-xs text-muted-foreground">
          Stationly records each read of these values in the audit log. Sealed values stay hidden.
        </p>
      )}
      {resolved.isError && <ErrorState error={resolved.error} title="Couldn’t load key values" />}
      <Panel title="Couldn’t load keys">
        <KeyRows
          target={target}
          values={values}
          onEdit={setEditing}
          onAdd={() => setAdding(true)}
          also={also}
        />
      </Panel>
      {adding && (
        <KeyDialog target={target} existing={null} open={adding} onOpenChange={setAdding} />
      )}
      {editing && (
        <KeyDialog
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
