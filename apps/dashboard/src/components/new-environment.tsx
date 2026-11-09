import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import type { Environment } from '@/lib/api'
import { slugPattern, slugTitle } from '@/lib/format'
import { cn } from '@/lib/utils'

const modes = [
  { value: 'empty', title: 'Empty', hint: 'No services yet' },
  { value: 'clone', title: 'Clone', hint: 'Copy services and variables' }
] as const

export function NewEnvironment({ project, environments, current }: { project: string; environments: Environment[]; current: Environment }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'empty' | 'clone'>('empty')
  const [source, setSource] = useState(current.id)
  const [deploy, setDeploy] = useState(true)
  const [protect, setProtect] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1.projects({ project }).environments.post(
          mode === 'clone' ? { name, source_environment_id: source, deploy_on_create: deploy, protected: protect } : { name, protected: protect },
          idempotency()
        )
      ),
    onSuccess: created => {
      void client.invalidateQueries({ queryKey: ['environments'] })
      void client.invalidateQueries({ queryKey: ['projects'] })
      const started = created.deployments.length
      const cloned = mode === 'clone' ? `${created.service_count} services cloned${started ? `, ${started} deployment${started === 1 ? '' : 's'} started` : ''}.` : 'It has no services yet.'
      toast.success(`${created.name} created`, { description: cloned })
      for (const warning of created.warnings) toast.warning(warning.code, { description: warning.explanation })
      setOpen(false)
      void navigate({ to: '/projects/$project/$environment', params: { project, environment: created.name }, search: { tab: 'services' } })
    },
    onError: failure => setError(failureText(failure))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    mutation.mutate()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New environment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>Create an environment</DialogTitle>
            <DialogDescription>An environment has its own network, services and variable values. sly environments create and the create_environment tool do the same.</DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="environment-name">Name</Label>
            <Input id="environment-name" required pattern={slugPattern} title={slugTitle} value={name} onChange={e => setName(e.target.value.toLowerCase())} className="font-mono" placeholder="staging" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Start from</legend>
            <div className="grid grid-cols-2 gap-2">
              {modes.map(option => (
                <label
                  key={option.value}
                  className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring')}
                >
                  <input type="radio" name="environment-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-0.5 accent-foreground" />
                  <span>
                    <span className="block font-medium">{option.title}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {mode === 'clone' && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="environment-source">Clone from</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger id="environment-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {environments.map(e => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Volumes start empty. A protected source passes on project defaults, not its own project values.</p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="environment-deploy" checked={deploy} onCheckedChange={v => setDeploy(v === true)} />
                <Label htmlFor="environment-deploy" className="font-normal">
                  Deploy the cloned services now
                </Label>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2">
            <Checkbox id="environment-protected" checked={protect} onCheckedChange={v => setProtect(v === true)} className="mt-0.5" />
            <div className="space-y-0.5">
              <Label htmlFor="environment-protected" className="font-normal">
                Protected
              </Label>
              <p className="text-xs text-muted-foreground">Every later change is staged until a human accepts it. Only a human can set this.</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Create environment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
