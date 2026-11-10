import { useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, Lock, Pencil, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Confirm, RemoveButton } from '@/components/confirm'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { Empty, ErrorState, Mono } from '@/components/page'
import { QueryState } from '@/components/query-state'
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
import { plural } from '@/lib/format'
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

const announce = (target: VariableTarget, verb: string, deployments: number) => {
  if (target.kind === 'sandbox')
    return {
      title: verb,
      description:
        'Running shells and execs use the new value at once; the init process at its next start.',
    }
  return {
    title: verb,
    description: deployments
      ? `${plural(deployments, 'deployment')} started.`
      : 'Dependents are marked stale until they redeploy.',
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
    invalidate: ['variables'],
    staged: () => `${verb} was staged for review`,
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
            ? `Project variable for the ${target.environment} environment.`
            : target.kind === 'sandbox'
              ? 'Sandbox variable. Use a reference to a project or global variable to keep a credential out of agent hands.'
              : 'Service variable.'}{' '}
          {target.kind === 'sandbox'
            ? 'A new value becomes a new version.'
            : 'A new value becomes a new version; running deployments keep the version they were given.'}
        </>
      }
      error={mutation.errorText}
      submitLabel="Save"
      pending={mutation.isPending}
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
                <SelectItem value="env">environment</SelectItem>
                <SelectItem value="file">file</SelectItem>
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
    invalidate: ['variables'],
    staged: () => `${variable.key} removed was staged for review`,
    success: (body) => announce(target, `${variable.key} removed`, body.deployments),
  })
  return (
    <Confirm
      title={`Remove ${variable.key}?`}
      description="Services that reference it fail to resolve on their next deployment. Removal is refused while another variable depends on it."
      onConfirm={() => mutation.mutateAsync()}
      trigger={<RemoveButton label={`Remove ${variable.key}`} />}
    />
  )
}

function ValueCell({ variable, revealed }: { variable: Variable; revealed: string | undefined }) {
  if (variable.kind === 'sealed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-sealed="true">
        <Lock className="size-3.5" aria-hidden />
        {variable.head_version
          ? `set, ${variable.bytes} bytes, version ${variable.head_version}`
          : 'not set'}
      </span>
    )
  }
  if (variable.kind === 'reference') return <Mono className="break-all">{variable.reference}</Mono>
  if (revealed !== undefined) return <Mono className="break-all">{revealed}</Mono>
  return (
    <span className="text-muted-foreground">
      {variable.head_version ? `hidden, version ${variable.head_version}` : 'not set'}
    </span>
  )
}

export function VariablesPanel({ target }: { target: VariableTarget }) {
  const list = useQuery(
    target.kind === 'service'
      ? variablesQuery(target.service)
      : target.kind === 'sandbox'
        ? sandboxVariablesQuery(target.sandbox)
        : projectVariablesQuery(target.project, target.environment),
  )
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
  const items = [...(list.data?.items ?? [])].sort((a, b) => a.key.localeCompare(b.key))
  const visible =
    target.kind === 'project'
      ? items.filter(
          (v) =>
            !v.environments ||
            v.environments.includes(target.environment) ||
            v.environments.includes('default'),
        )
      : items

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {target.kind === 'service'
            ? 'Variables set on this service. References resolve at deploy time.'
            : target.kind === 'sandbox'
              ? 'Variables set on this sandbox. References resolve when the sandbox starts and when a value changes.'
              : `Project variables that apply to ${target.environment}, with project defaults.`}
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
              {reveal ? 'Hide values' : 'Show literal values'}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add variable
          </Button>
        </div>
      </div>
      {reveal && (
        <p className="text-xs text-muted-foreground">
          Each read of the resolved values is written to the audit log. Sealed values are never
          shown.
        </p>
      )}
      {resolved.isError && <ErrorState error={resolved.error} title="Values could not be read" />}
      <QueryState
        query={list}
        isEmpty={() => visible.length === 0}
        empty={
          <Empty title="No variables">
            {target.kind === 'sandbox'
              ? 'Add one here, with sly sandbox variables set, or with the set_sandbox_variables MCP tool.'
              : `Add one here, with sly variables set, or with the ${target.kind === 'project' ? 'set_project_variables' : 'set_service_variables'} MCP tool.`}
          </Empty>
        }
      >
        {() => (
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
                    <Mono className="font-medium">{variable.key}</Mono>
                    {target.kind === 'project' &&
                      variable.environments &&
                      !variable.environments.includes(target.environment) && (
                        <Badge variant="outline" className="ml-2 text-muted-foreground">
                          default
                        </Badge>
                      )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={variable.kind === 'sealed' ? 'secondary' : 'outline'}>
                      {variable.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-0 whitespace-normal">
                    <ValueCell variable={variable} revealed={values.get(variable.id)} />
                  </TableCell>
                  {target.kind !== 'sandbox' && (
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {variable.injection}
                      {variable.build && ' · build'}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Change ${variable.key}`}
                      onClick={() => setEditing(variable)}
                    >
                      <Pencil />
                    </Button>
                    <RemoveVariable target={target} variable={variable} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableFrame>
        )}
      </QueryState>
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
