import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AlsoWith } from '@/components/code'
import { Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { api, idempotency, send } from '@/lib/api'
import { seed } from '@/lib/cache'
import { commands } from '@/lib/commands'
import { placeTo } from '@/lib/links'
import { useApiMutation } from '@/lib/mutation'
import { projectQuery } from '@/lib/queries'

export function NewProject({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1.projects.post(
          {
            name,
          },
          idempotency(),
        ),
      ),
    seed: (project) => [seed(projectQuery(project.name), project)],
    invalidate: ['projects'],
    success: (project) => ({
      title: `${project.name} created`,
      description: 'Add an app to its production.',
    }),
    onSuccess: (result) => {
      onOpenChange(false)

      if (!result.waiting) {
        void navigate(placeTo(result.body.name, null))
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
      description="Starts with production. Every change to production waits for an approval; previews apply at once."
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
    </FormDialog>
  )
}
