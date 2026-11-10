import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { AlsoWith } from '@/components/code'
import { Field, hintId } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { api, idempotency, send } from '@/lib/api'
import { commands } from '@/lib/commands'
import { useApiMutation } from '@/lib/mutation'
import { projectQuery, seed } from '@/lib/queries'

export function NewProject({
  trigger = (
    <Button size="sm">
      <Plus /> New project
    </Button>
  ),
}: {
  trigger?: ReactNode
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('')
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1.projects.post(
          {
            name,
            default_environment_name: environment || undefined,
          },
          idempotency(),
        ),
      ),
    seed: (project) => [seed(projectQuery(project.name), project)],
    invalidate: ['projects'],
    success: (project) => ({
      title: `${project.name} created`,
      description: 'Add a service to its first environment.',
    }),
    onSuccess: (result) => {
      setOpen(false)
      if (!result.staged)
        void navigate({
          to: '/projects/$project',
          params: {
            project: result.body.name,
          },
        })
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
      trigger={trigger}
      title="Create a project"
      description="Starts with one environment, named production unless you pick another name."
      also={<AlsoWith cli={commands.createProject()} tool="create_project" />}
      error={mutation.errorText}
      submitLabel="Create project"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="project-name" label="Name">
        <SlugInput
          id="project-name"
          required
          value={name}
          onValueChange={setName}
          placeholder="shop"
        />
      </Field>
      <Field
        id="project-environment"
        label="First environment"
        hint="Leave it empty for production."
      >
        <SlugInput
          id="project-environment"
          value={environment}
          onValueChange={setEnvironment}
          placeholder="production"
          aria-describedby={hintId('project-environment')}
        />
      </Field>
    </FormDialog>
  )
}
