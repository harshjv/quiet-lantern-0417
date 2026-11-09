import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, failureText, idempotency, unwrap } from '@/lib/api'
import { slugPattern, slugTitle } from '@/lib/format'

export function NewProject() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => unwrap(api.v1.projects.post({ name, default_environment_name: environment || undefined }, idempotency())),
    onSuccess: project => {
      void client.invalidateQueries({ queryKey: ['projects'] })
      toast.success(`${project.name} created`, { description: 'Add a service to its first environment.' })
      setOpen(false)
      void navigate({ to: '/projects/$project', params: { project: project.name } })
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
        <Button size="sm">
          <Plus /> New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>Create a project</DialogTitle>
            <DialogDescription>A project starts with one environment. sly projects create and the create_project tool do the same.</DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" required pattern={slugPattern} title={slugTitle} value={name} onChange={e => setName(e.target.value.toLowerCase())} className="font-mono" placeholder="shop" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-environment">First environment</Label>
            <Input id="project-environment" pattern={slugPattern} title={slugTitle} value={environment} onChange={e => setEnvironment(e.target.value.toLowerCase())} className="font-mono" placeholder="production" aria-describedby="project-environment-hint" />
            <p id="project-environment-hint" className="text-xs text-muted-foreground">
              Leave empty for production.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
