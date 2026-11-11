import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { ChoiceCards } from '@/components/choice-cards'
import { AlsoWith } from '@/components/code'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, idempotency, send, type Environment } from '@/lib/api'
import { commands } from '@/lib/commands'
import { plural } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { seedEnvironment } from '@/lib/queries'

const modes = [
  {
    value: 'empty',
    title: 'Empty',
    hint: 'No services',
  },
  {
    value: 'clone',
    title: 'Clone',
    hint: 'Copies services and variables',
  },
] as const

export function NewEnvironment({
  project,
  environments,
  current,
}: {
  project: string
  environments: Environment[]
  current?: Environment
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'empty' | 'clone'>('empty')
  const [source, setSource] = useState(current?.id ?? '')
  const [deploy, setDeploy] = useState(true)
  const [protect, setProtect] = useState(false)
  const sourceName = environments.find((e) => e.id === source)?.name ?? ''
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({
            project,
          })
          .environments.post(
            mode === 'clone'
              ? {
                  name,
                  source_environment_id: source,
                  deploy_on_create: deploy,
                  protected: protect,
                }
              : {
                  name,
                  protected: protect,
                },
            idempotency(),
          ),
      ),
    seed: (created) => seedEnvironment(project, created),
    invalidate: ['environments'],
    success: (created) => {
      const started = created.deployments.length

      return {
        title: `${created.name} created`,
        description:
          mode === 'clone'
            ? `${plural(created.service_count, 'service')} cloned${started ? `, ${plural(started, 'deployment')} started` : ''}.`
            : 'Add its first service.',
      }
    },
    onSuccess: (result) => {
      setOpen(false)

      if (!result.staged) {
        void navigate({
          to: '/projects/$project/$environment',
          params: {
            project,
            environment: result.body.name,
          },
          search: {
            tab: 'services',
          },
        })
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
          <Plus /> New environment
        </Button>
      }
      size="md"
      title="Create an environment"
      description="Gets its own network, services and variable values."
      also={<AlsoWith cli={commands.createEnvironment(project)} tool="create_environment" />}
      error={mutation.errorText}
      submitLabel="Create environment"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="environment-name" label="Name">
        <SlugInput
          id="environment-name"
          required
          value={name}
          onValueChange={setName}
          placeholder="staging"
        />
      </Field>
      {current && (
        <ChoiceCards
          name="environment-mode"
          legend="Start from"
          value={mode}
          onChange={setMode}
          options={modes}
        />
      )}
      {mode === 'clone' && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <Field
            id="environment-source"
            label="Clone from"
            hint={`Volumes start empty. When ${sourceName} is protected, variables come from the project defaults, not from ${sourceName}’s own values.`}
          >
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="environment-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <CheckboxField
            id="environment-deploy"
            checked={deploy}
            onCheckedChange={setDeploy}
            label="Deploy the cloned services now"
          />
        </div>
      )}
      <CheckboxField
        id="environment-protected"
        checked={protect}
        onCheckedChange={setProtect}
        label="Protected"
        hint="Changes from agents and tokens wait for you to accept them. Agents and tokens can’t turn this off."
      />
    </FormDialog>
  )
}
