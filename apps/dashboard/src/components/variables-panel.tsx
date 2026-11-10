import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Braces, Eye, EyeOff, Lock, Pencil, Plus } from 'lucide-react'
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
  VariableKeyInput,
  VariableKindSelect,
  VariableNotes,
  VariableValueInput,
} from '@/components/variable-fields'
import { api, idempotency, send, unwrap, type Variable } from '@/lib/api'
import { editItems, isOptimistic } from '@/lib/cache'
import { plural } from '@/lib/format'
import { injection as injectionLabel, variableKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  projectVariablesQuery,
  resolvedQuery,
  sandboxResolvedQuery,
  sandboxVariablesQuery,
  variablesQuery,
} from '@/lib/queries'
import {
  toSandboxVariableInput,
  toVariableInput,
  withDraft,
  withoutKeys,
  type VariableEntry,
  type VariableKind,
} from '@/lib/variables'

export type VariableTarget =
  | { kind: 'service'; service: string }
  | { kind: 'project'; project: string; environment: string }
  | { kind: 'sandbox'; sandbox: string }

type Outcome =
  { staged: true; body: { id: string } } | { staged: false; body: { deployments: number } }

type Patch = { set?: VariableEntry[]; unset?: string[]; apply: boolean }

async function patchVariables(
  target: VariableTarget,
  { set, unset, apply }: Patch,
): Promise<Outcome> {
  if (target.kind === 'sandbox') {
    await unwrap(
      api.v1
        .sandboxes({
          sandbox: target.sandbox,
        })
        .variables.patch(
          {
            set: set?.map(toSandboxVariableInput),
            unset,
          },
          idempotency(),
        ),
    )
    return {
      staged: false,
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
    target.kind === 'service'
      ? api.v1
          .services({
            service: target.service,
          })
          .variables.patch(body, idempotency())
      : api.v1
          .projects({
            project: target.project,
          })
          .variables.patch(
            {
              environment: target.environment,
              ...body,
            },
            idempotency(),
          ),
  )
  return result.staged
    ? {
        staged: true,
        body: {
          id: result.body.id,
        },
      }
    : {
        staged: false,
        body: {
          deployments: result.body.deployments?.length ?? 0,
        },
      }
}

const listQuery = (target: VariableTarget) =>
  target.kind === 'service'
    ? variablesQuery(target.service)
    : target.kind === 'sandbox'
      ? sandboxVariablesQuery(target.sandbox)
      : projectVariablesQuery(target.project, target.environment)

const drafts = (target: VariableTarget, { set = [], unset = [] }: Patch) => [
  editItems(listQuery(target), (list) =>
    withoutKeys(
      set.reduce((next, entry) => withDraft(next, entry, target.kind), list),
      unset,
    ),
  ),
]

const announce = (target: VariableTarget, verb: string, deployments: number) => {
  if (target.kind === 'sandbox')
    return {
      title: verb,
      description:
        'Shells and commands use the new value now. The sandbox’s startup process gets it on next start.',
    }
  return {
    title: verb,
    description: deployments
      ? `${plural(deployments, 'deployment')} started.`
      : 'Services that use it pick it up on their next deploy.',
  }
}

function VariableDialog({
  target,
  existing,
  open,
  onOpenChange,
}: {
  target: VariableTarget
  existing: Variable | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [key, setKey] = useState(existing?.key ?? '')
  const [kind, setKind] = useState<VariableKind>(existing?.kind ?? 'literal')
  const [value, setValue] = useState('')
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [injection, setInjection] = useState<'env' | 'file'>(existing?.injection ?? 'env')
  const [build, setBuild] = useState(existing?.build ?? false)
  const [apply, setApply] = useState(false)
  const [touched, setTouched] = useState(false)
  const loadsValue = existing?.kind === 'literal' && target.kind !== 'project'
  const serviceResolved = useQuery({
    ...resolvedQuery(target.kind === 'service' ? target.service : ''),
    enabled: loadsValue && target.kind === 'service',
  })
  const sandboxResolved = useQuery({
    ...sandboxResolvedQuery(target.kind === 'sandbox' ? target.sandbox : ''),
    enabled: loadsValue && target.kind === 'sandbox',
  })
  const current = loadsValue
    ? (target.kind === 'sandbox' ? sandboxResolved : serviceResolved).data?.variables.find(
        (v) => v.variable_id === existing?.id,
      )?.value
    : undefined
  useEffect(() => {
    if (current !== undefined && !touched) setValue(current)
  }, [current, touched])
  const verb = existing ? `${key} updated` : `${key} added`
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
    invalidate: ['variables'],
    staged: () => `${existing ? 'Change' : 'Add'} ${key.trim()}`,
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
        if (!next) setValue('')
        onOpenChange(next)
      }}
      title={existing ? `Change ${existing.key}` : 'Add a variable'}
      description={
        <>
          {target.kind === 'project'
            ? `Shared by every service in ${target.environment}.`
            : target.kind === 'sandbox'
              ? 'Reference a project or global variable to keep a credential out of an agent’s reach.'
              : 'Reaches this service as an environment variable or a file.'}{' '}
          {target.kind === 'sandbox'
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
          key: key.trim(),
          kind,
          value: isReference ? reference : value,
          injection,
          build,
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field id="var-key" label="Key">
          <VariableKeyInput
            id="var-key"
            value={key}
            onValueChange={setKey}
            disabled={Boolean(existing)}
          />
        </Field>
        <Field id="var-kind" label="Kind">
          <VariableKindSelect id="var-kind" value={kind} onValueChange={setKind} />
        </Field>
      </div>
      <Field id="var-value" label={isReference ? 'Reference' : 'Value'}>
        <VariableValueInput
          id="var-value"
          kind={kind}
          multiline
          value={isReference ? reference : value}
          onValueChange={(next) => {
            if (isReference) return setReference(next)
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
      {target.kind !== 'sandbox' && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="var-injection" className="font-normal">
              Injected as
            </Label>
            <Select value={injection} onValueChange={(v) => setInjection(v as 'env' | 'file')}>
              <SelectTrigger id="var-injection" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="env">{injectionLabel.env}</SelectItem>
                <SelectItem value="file">{injectionLabel.file}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CheckboxField
            id="var-build"
            checked={build}
            onCheckedChange={setBuild}
            label="Available at build time"
          />
          <CheckboxField
            id="var-apply"
            checked={apply}
            onCheckedChange={setApply}
            label="Redeploy dependents now"
          />
        </div>
      )}
      <VariableNotes sealed={kind === 'sealed'} build={target.kind !== 'sandbox' && build} />
    </FormDialog>
  )
}

function RemoveVariable({ target, variable }: { target: VariableTarget; variable: Variable }) {
  const mutation = useApiMutation({
    mutationFn: () =>
      patchVariables(target, {
        unset: [variable.key],
        apply: false,
      }),
    optimistic: () =>
      drafts(target, {
        unset: [variable.key],
        apply: false,
      }),
    invalidate: ['variables'],
    staged: () => `Remove ${variable.key}`,
    success: (body) => announce(target, `${variable.key} removed`, body.deployments),
  })
  return (
    <Confirm
      title={`Remove ${variable.key}?`}
      description="Services that use it lose it on their next deployment. Stationly keeps it while another variable references it."
      action="Remove variable"
      cancel="Keep variable"
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${variable.key}`} disabled={isOptimistic(variable)} />}
    />
  )
}

function ValueCell({ variable, revealed }: { variable: Variable; revealed: string | undefined }) {
  if (isOptimistic(variable)) return <Saving />
  if (variable.kind === 'sealed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-sealed="true">
        <Lock className="size-3.5" aria-hidden />
        {variable.head_version
          ? `Hidden · ${variable.bytes} bytes · version ${variable.head_version}`
          : 'Not set'}
      </span>
    )
  }
  if (variable.kind === 'reference') return <Code>{variable.reference}</Code>
  if (revealed !== undefined) return <Code>{revealed}</Code>
  return (
    <span className="text-muted-foreground">
      {variable.head_version ? `Hidden · version ${variable.head_version}` : 'Not set'}
    </span>
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
  onEdit: (variable: Variable) => void
  onAdd: () => void
  also?: ReactNode
}) {
  const { data } = useSuspenseQuery(listQuery(target))
  const items = [...data.items].sort((a, b) => a.key.localeCompare(b.key))
  const visible =
    target.kind === 'project'
      ? items.filter(
          (v) =>
            !v.environments ||
            v.environments.includes(target.environment) ||
            v.environments.includes('default'),
        )
      : items
  if (visible.length === 0)
    return (
      <EmptyState
        icon={Braces}
        title="No variables yet"
        description={
          target.kind === 'sandbox'
            ? 'Variables reach this sandbox as environment variables. Seal the ones that hold secrets.'
            : target.kind === 'project'
              ? `Shared variables reach every service in ${target.environment}. Seal the ones that hold secrets.`
              : 'Variables reach this service as environment variables. Seal the ones that hold secrets.'
        }
        action={
          <Button size="sm" onClick={onAdd}>
            <Plus /> Add variable
          </Button>
        }
        also={also}
      />
    )
  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[28%]">Key</TableHead>
          <TableHead className="w-24">Kind</TableHead>
          <TableHead>Value</TableHead>
          {target.kind !== 'sandbox' && (
            <TableHead className="hidden w-36 md:table-cell">Injection</TableHead>
          )}
          <ActionsHead className="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((variable) => (
          <TableRow key={variable.id}>
            <TableCell>
              <span className="font-mono text-[0.8125rem] font-medium">{variable.key}</span>
              {target.kind === 'project' &&
                variable.environments &&
                !variable.environments.includes(target.environment) && (
                  <Badge variant="outline" className="ml-2 text-muted-foreground">
                    Project default
                  </Badge>
                )}
            </TableCell>
            <TableCell>
              <Badge variant={variable.kind === 'sealed' ? 'secondary' : 'outline'}>
                {variableKind[variable.kind]}
              </Badge>
            </TableCell>
            <TableCell className="max-w-0 whitespace-normal">
              <ValueCell variable={variable} revealed={values.get(variable.id)} />
            </TableCell>
            {target.kind !== 'sandbox' && (
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {injectionLabel[variable.injection]}
                {variable.build && ' · also at build'}
              </TableCell>
            )}
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Change ${variable.key}`}
                disabled={isOptimistic(variable)}
                onClick={() => onEdit(variable)}
              >
                <Pencil />
              </Button>
              <RemoveVariable target={target} variable={variable} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

export function VariablesPanel({ target, also }: { target: VariableTarget; also?: ReactNode }) {
  const [reveal, setReveal] = useState(false)
  const serviceResolved = useQuery({
    ...resolvedQuery(target.kind === 'service' ? target.service : ''),
    enabled: reveal && target.kind === 'service',
  })
  const sandboxResolved = useQuery({
    ...sandboxResolvedQuery(target.kind === 'sandbox' ? target.sandbox : ''),
    enabled: reveal && target.kind === 'sandbox',
  })
  const resolved = target.kind === 'sandbox' ? sandboxResolved : serviceResolved
  const [editing, setEditing] = useState<Variable | null>(null)
  const [adding, setAdding] = useState(false)
  const values = new Map(
    (resolved.data?.variables ?? [])
      .filter((v) => !v.sealed && v.value !== undefined)
      .map((v) => [v.variable_id, v.value!]),
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {target.kind === 'service'
            ? 'Variables of this service. Stationly resolves references when it deploys.'
            : target.kind === 'sandbox'
              ? 'Variables of this sandbox. Stationly resolves references when the sandbox starts and when a value changes.'
              : `Shared variables for every service in ${target.environment}, plus project defaults.`}
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
            <Plus /> Add variable
          </Button>
        </div>
      </div>
      {reveal && (
        <p className="text-xs text-muted-foreground">
          Stationly records each read of these values in the audit log. Sealed values stay hidden.
        </p>
      )}
      {resolved.isError && (
        <ErrorState error={resolved.error} title="Couldn’t load variable values" />
      )}
      <Panel title="Couldn’t load variables">
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
