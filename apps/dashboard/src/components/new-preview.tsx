import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { AlsoWith } from '@/components/code'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { api, idempotency, send } from '@/lib/api'
import { commands } from '@/lib/commands'
import { plural } from '@/lib/format'
import { placeTo } from '@/lib/links'
import { useApiMutation } from '@/lib/mutation'
import { seedPreview } from '@/lib/queries'

export function NewPreview({ project, projectName }: { project: string; projectName: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [deploy, setDeploy] = useState(true)
  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({
            project,
          })
          .previews.post(
            {
              name,
              deploy_on_create: deploy,
            },
            idempotency(),
          ),
      ),
    seed: (created) => seedPreview(project, created),
    invalidate: ['previews'],
    success: (created) => {
      const started = created.deployments.length

      return {
        title: `${created.name} created`,
        description: `${plural(created.app_count, 'app')} copied from production${started ? `, ${plural(started, 'deployment')} started` : ''}.`,
      }
    },
    onSuccess: (result) => {
      setOpen(false)

      if (!result.waiting) {
        void navigate(placeTo(projectName, result.body.name))
      }
    },
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          mutation.reset()
        }
      }}
      trigger={
        <Button size="sm" variant="outline">
          <Plus /> New preview
        </Button>
      }
      size="md"
      title="Create a preview"
      description="Copies production’s apps onto their own network, with no domains until you add them. Volumes start empty, and production’s sealed values never reach a preview."
      also={<AlsoWith cli={commands.createPreview(projectName)} tool="create_preview" />}
      error={mutation.errorText}
      submitLabel="Create preview"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="preview-name" label="Name">
        <SlugInput
          id="preview-name"
          required
          value={name}
          onValueChange={setName}
          placeholder="staging"
        />
      </Field>
      <CheckboxField
        id="preview-deploy"
        checked={deploy}
        onCheckedChange={setDeploy}
        label="Deploy the copied apps now"
      />
    </FormDialog>
  )
}
