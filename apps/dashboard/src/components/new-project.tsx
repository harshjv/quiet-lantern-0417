import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Field, hintId } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { api, idempotency, send } from '@/lib/api'
import { useApiMutation } from '@/lib/mutation'

export function NewProject() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('')
  const mutation = useApiMutation({
    mutationFn: () => send(api.v1.projects.post({ name, default_environment_name: environment || undefined }, idempotency())),
    invalidate: ['projects'],
    success: project => ({ title: `${project.name} created`, description: 'Add a service to its first environment.' }),
    onSuccess: result => {
      setOpen(false)
      if (!result.staged) void navigate({ to: '/projects/$project', params: { project: result.body.name } })
    }
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
      trigger={
        <Button size="sm">
          <Plus /> New project
        </Button>
      }
      title="Create a project"
      description="A project starts with one environment. sly projects create and the create_project tool do the same."
      error={mutation.errorText}
      submitLabel="Create project"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="project-name" label="Name">
        <SlugInput id="project-name" required value={name} onValueChange={setName} placeholder="shop" />
      </Field>
      <Field id="project-environment" label="First environment" hint="Leave empty for production.">
        <SlugInput id="project-environment" value={environment} onValueChange={setEnvironment} placeholder="production" aria-describedby={hintId('project-environment')} />
      </Field>
    </FormDialog>
  )
}
