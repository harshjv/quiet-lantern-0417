import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Empty, ErrorState, Mono, Rows } from '@/components/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, failureText, idempotency, send, unwrap } from '@/lib/api'
import { projectVariablesQuery, resolvedQuery, sandboxResolvedQuery, sandboxVariablesQuery, variablesQuery } from '@/lib/queries'
import type { Variable } from '@/lib/api'

export type VariableTarget = { kind: 'service'; service: string } | { kind: 'project'; project: string; environment: string } | { kind: 'sandbox'; sandbox: string }

type SetEntry = { key: string; kind: Variable['kind']; value?: string; reference?: string; injection: 'env' | 'file'; build: boolean }

type Outcome = { staged: true; id: string } | { staged: false; deployments: number }

type Patch = { set?: SetEntry[]; unset?: string[]; apply: boolean }

async function patchVariables(target: VariableTarget, body: Patch): Promise<Outcome> {
  if (target.kind === 'sandbox') {
    const set = body.set?.map(({ key, kind, value, reference }) => ({ key, kind, value, reference }))
    await unwrap(api.v1.sandboxes({ sandbox: target.sandbox }).variables.patch({ set, unset: body.unset }, idempotency()))
    return { staged: false, deployments: 0 }
  }
  const result = await send(
    target.kind === 'service'
      ? api.v1.services({ service: target.service }).variables.patch(body, idempotency())
      : api.v1.projects({ project: target.project }).variables.patch({ environment: target.environment, ...body }, idempotency())
  )
  return result.staged ? { staged: true, id: result.body.id } : { staged: false, deployments: result.body.deployments?.length ?? 0 }
}

function announce(result: Outcome, verb: string, target: VariableTarget) {
  if (result.staged) {
    toast.message(`${verb} was staged for review`, {
      description: 'This environment is protected; a human accepts the change on the staged changes page.',
      action: { label: 'Review', onClick: () => window.location.assign(`/staged/${result.id}`) }
    })
    return
  }
  if (target.kind === 'sandbox') {
    toast.success(verb, { description: 'Running shells and execs use the new value at once; the init process at its next start.' })
    return
  }
  toast.success(verb, { description: result.deployments ? `${result.deployments} deployment${result.deployments === 1 ? '' : 's'} started.` : 'Dependents are marked stale until they redeploy.' })
}

function VariableDialog({ target, existing, open, onOpenChange }: { target: VariableTarget; existing: Variable | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const [key, setKey] = useState(existing?.key ?? '')
  const [kind, setKind] = useState<Variable['kind']>(existing?.kind ?? 'literal')
  const [value, setValue] = useState('')
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [injection, setInjection] = useState<'env' | 'file'>(existing?.injection ?? 'env')
  const [build, setBuild] = useState(existing?.build ?? false)
  const [apply, setApply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (entry: SetEntry) => patchVariables(target, { set: [entry], apply }),
    onSuccess: result => {
      setValue('')
      announce(result, existing ? `${key} updated` : `${key} added`, target)
      void client.invalidateQueries({ queryKey: ['variables'] })
      void client.invalidateQueries({ queryKey: ['services'] })
      onOpenChange(false)
    },
    onError: failure => setError(failureText(failure))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const entry: SetEntry = { key: key.trim(), kind, injection, build }
    if (kind === 'reference') entry.reference = reference
    else entry.value = value
    mutation.mutate(entry)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) setValue('')
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>{existing ? `Change ${existing.key}` : 'Add a variable'}</DialogTitle>
            <DialogDescription>
              {target.kind === 'project' ? `Project variable for the ${target.environment} environment.` : target.kind === 'sandbox' ? 'Sandbox variable. Use a reference to a project or global variable to keep a credential out of agent hands.' : 'Service variable.'}{' '}
              {target.kind === 'sandbox' ? 'A new value becomes a new version.' : 'A new value becomes a new version; running deployments keep the version they were given.'}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div className="space-y-1.5">
              <Label htmlFor="var-key">Key</Label>
              <Input id="var-key" required pattern="^[A-Z_][A-Z0-9_]*$" title="Upper case letters, digits and underscores" value={key} onChange={e => setKey(e.target.value.toUpperCase())} disabled={Boolean(existing)} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="var-kind">Kind</Label>
              <Select value={kind} onValueChange={v => setKind(v as Variable['kind'])}>
                <SelectTrigger id="var-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="literal">literal</SelectItem>
                  <SelectItem value="sealed">sealed</SelectItem>
                  <SelectItem value="reference">reference</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {kind === 'reference' ? (
            <div className="space-y-1.5">
              <Label htmlFor="var-ref">Reference</Label>
              <Input id="var-ref" required placeholder="${{db.HOST}}" value={reference} onChange={e => setReference(e.target.value)} className="font-mono" />
            </div>
          ) : kind === 'sealed' ? (
            <div className="space-y-1.5">
              <Label htmlFor="var-value">Value</Label>
              <Input id="var-value" type="password" required autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} className="font-mono" />
              <p className="text-xs text-muted-foreground">Sealed values are write-only. No endpoint returns them, including to you.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="var-value">Value</Label>
              <Textarea id="var-value" required rows={3} value={value} onChange={e => setValue(e.target.value)} className="font-mono" spellCheck={false} />
            </div>
          )}
          {target.kind !== 'sandbox' && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="var-injection" className="font-normal">
                Injected as
              </Label>
              <Select value={injection} onValueChange={v => setInjection(v as 'env' | 'file')}>
                <SelectTrigger id="var-injection" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="env">environment</SelectItem>
                  <SelectItem value="file">file</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="var-build" checked={build} onCheckedChange={v => setBuild(v === true)} />
              <Label htmlFor="var-build" className="font-normal">
                Available at build time
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="var-apply" checked={apply} onCheckedChange={v => setApply(v === true)} />
              <Label htmlFor="var-apply" className="font-normal">
                Redeploy dependents now
              </Label>
            </div>
          </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveVariable({ target, variable }: { target: VariableTarget; variable: Variable }) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => patchVariables(target, { unset: [variable.key], apply: false }),
    onSuccess: result => {
      announce(result, `${variable.key} removed`, target)
      void client.invalidateQueries({ queryKey: ['variables'] })
    },
    onError: failure => toast.error(`${variable.key} was not removed`, { description: failureText(failure) })
  })
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${variable.key}`}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {variable.key}?</AlertDialogTitle>
          <AlertDialogDescription>Services that reference it fail to resolve on their next deployment. Removal is refused while another variable depends on it.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => mutation.mutate()}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ValueCell({ variable, revealed }: { variable: Variable; revealed: string | undefined }) {
  if (variable.kind === 'sealed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-sealed="true">
        <Lock className="size-3.5" aria-hidden />
        {variable.head_version ? `set, ${variable.bytes} bytes, version ${variable.head_version}` : 'not set'}
      </span>
    )
  }
  if (variable.kind === 'reference') return <Mono className="break-all">{variable.reference}</Mono>
  if (revealed !== undefined) return <Mono className="break-all">{revealed}</Mono>
  return <span className="text-muted-foreground">{variable.head_version ? `hidden, version ${variable.head_version}` : 'not set'}</span>
}

export function VariablesPanel({ target }: { target: VariableTarget }) {
  const list = useQuery(target.kind === 'service' ? variablesQuery(target.service) : target.kind === 'sandbox' ? sandboxVariablesQuery(target.sandbox) : projectVariablesQuery(target.project, target.environment))
  const [reveal, setReveal] = useState(false)
  const serviceResolved = useQuery({ ...resolvedQuery(target.kind === 'service' ? target.service : ''), enabled: reveal && target.kind === 'service' })
  const sandboxResolved = useQuery({ ...sandboxResolvedQuery(target.kind === 'sandbox' ? target.sandbox : ''), enabled: reveal && target.kind === 'sandbox' })
  const resolved = target.kind === 'sandbox' ? sandboxResolved : serviceResolved
  const [editing, setEditing] = useState<Variable | null>(null)
  const [adding, setAdding] = useState(false)
  const values = new Map((resolved.data?.variables ?? []).filter(v => !v.sealed && v.value !== undefined).map(v => [v.variable_id, v.value!]))
  const items = [...(list.data?.items ?? [])].sort((a, b) => a.key.localeCompare(b.key))
  const visible = target.kind === 'project' ? items.filter(v => !v.environments || v.environments.includes(target.environment) || v.environments.includes('default')) : items

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {target.kind === 'service' ? 'Variables set on this service. References resolve at deploy time.' : target.kind === 'sandbox' ? 'Variables set on this sandbox. References resolve when the sandbox starts and when a value changes.' : `Project variables that apply to ${target.environment}, with project defaults.`}
        </p>
        <div className="flex items-center gap-2">
          {target.kind !== 'project' && (
            <Button variant="outline" size="sm" onClick={() => setReveal(r => !r)} aria-pressed={reveal}>
              {reveal ? <EyeOff /> : <Eye />}
              {reveal ? 'Hide values' : 'Show literal values'}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add variable
          </Button>
        </div>
      </div>
      {reveal && <p className="text-xs text-muted-foreground">Each read of the resolved values is written to the audit log. Sealed values are never shown.</p>}
      {resolved.isError && <ErrorState error={resolved.error} title="Values could not be read" />}
      {list.isPending ? (
        <Rows />
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : visible.length === 0 ? (
        <Empty title="No variables">{target.kind === 'sandbox' ? 'Add one here, with sly sandbox variables set, or with the set_sandbox_variables MCP tool.' : 'Add one here, with sly variables set, or with the set_variables MCP tool.'}</Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Key</TableHead>
                <TableHead className="w-24">Kind</TableHead>
                <TableHead>Value</TableHead>
                {target.kind !== 'sandbox' && <TableHead className="hidden w-36 md:table-cell">Injection</TableHead>}
                <TableHead className="w-20 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(variable => (
                <TableRow key={variable.id}>
                  <TableCell>
                    <Mono className="font-medium">{variable.key}</Mono>
                    {target.kind === 'project' && variable.environments && !variable.environments.includes(target.environment) && (
                      <Badge variant="outline" className="ml-2 text-muted-foreground">
                        default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={variable.kind === 'sealed' ? 'secondary' : 'outline'}>{variable.kind}</Badge>
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
                    <Button variant="ghost" size="icon-sm" aria-label={`Change ${variable.key}`} onClick={() => setEditing(variable)}>
                      <Pencil />
                    </Button>
                    <RemoveVariable target={target} variable={variable} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {adding && <VariableDialog target={target} existing={null} open={adding} onOpenChange={setAdding} />}
      {editing && <VariableDialog key={editing.id} target={target} existing={editing} open={Boolean(editing)} onOpenChange={open => !open && setEditing(null)} />}
    </div>
  )
}
