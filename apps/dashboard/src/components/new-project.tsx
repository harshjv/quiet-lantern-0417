import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AlsoWith } from '@/components/code'
import { Field, hintId } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { api, idempotency, send } from '@/lib/api'
import { seed } from '@/lib/cache'
import { commands } from '@/lib/commands'
import { useApiMutation } from '@/lib/mutation'
import { projectQuery } from '@/lib/queries'

export function NewProject({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
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
      onOpenChange(false)

      if (!result.staged) {
        void navigate({
          to: '/projects/$project',
          params: {
            project: result.body.name,
          },
        })
      }
    },
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)

        if (!next) {
          mutation.reset()
        }
      }}
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
