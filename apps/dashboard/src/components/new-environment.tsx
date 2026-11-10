import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { ChoiceCards } from '@/components/choice-cards'
import { CheckboxField, Field } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, idempotency, send } from '@/lib/api'
import type { Environment } from '@/lib/api'
import { plural } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'

const modes = [
  { value: 'empty', title: 'Empty', hint: 'No services yet' },
  { value: 'clone', title: 'Clone', hint: 'Copy services and variables' }
] as const

export function NewEnvironment({ project, environments, current }: { project: string; environments: Environment[]; current: Environment }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'empty' | 'clone'>('empty')
  const [source, setSource] = useState(current.id)
  const [deploy, setDeploy] = useState(true)
  const [protect, setProtect] = useState(false)
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({ project })
          .environments.post(mode === 'clone' ? { name, source_environment_id: source, deploy_on_create: deploy, protected: protect } : { name, protected: protect }, idempotency())
      ),
    invalidate: ['environments'],
    success: created => {
      const started = created.deployments.length
      return {
        title: `${created.name} created`,
        description: mode === 'clone' ? `${created.service_count} services cloned${started ? `, ${plural(started, 'deployment')} started` : ''}.` : 'It has no services yet.'
      }
    },
    onSuccess: result => {
      setOpen(false)
      if (!result.staged) void navigate({ to: '/projects/$project/$environment', params: { project, environment: result.body.name }, search: { tab: 'services' } })
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
        <Button size="sm" variant="outline">
          <Plus /> New environment
        </Button>
      }
      size="md"
      title="Create an environment"
      description="An environment has its own network, services and variable values. sly environments create and the create_environment tool do the same."
      error={mutation.errorText}
      submitLabel="Create environment"
      pending={mutation.isPending}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="environment-name" label="Name">
        <SlugInput id="environment-name" required value={name} onValueChange={setName} placeholder="staging" />
      </Field>
      <ChoiceCards name="environment-mode" legend="Start from" value={mode} onChange={setMode} options={modes} />
      {mode === 'clone' && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <Field id="environment-source" label="Clone from" hint="Volumes start empty. A protected source passes on project defaults, not its own project values.">
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
          </Field>
          <CheckboxField id="environment-deploy" checked={deploy} onCheckedChange={setDeploy} label="Deploy the cloned services now" />
        </div>
      )}
      <CheckboxField
        id="environment-protected"
        checked={protect}
        onCheckedChange={setProtect}
        label="Protected"
        hint="Every later change is staged until a human accepts it. Only a human can set this."
      />
    </FormDialog>
  )
}
