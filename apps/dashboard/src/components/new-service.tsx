import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { AlsoWith } from '@/components/code'
import { RemoveButton } from '@/components/confirm'
import { CheckboxField, Field, FieldSet, hintId } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Term } from '@/components/term'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  VariableKeyInput,
  VariableKindSelect,
  VariableNotes,
  VariableValueInput,
} from '@/components/variable-fields'
import { api, idempotency, send, type Environment } from '@/lib/api'
import { commands } from '@/lib/commands'
import { serviceKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import { onlineStationsQuery, projectQuery, seedService } from '@/lib/queries'
import { useRows } from '@/lib/use-rows'
import { toVariableInput, type VariableEntry } from '@/lib/variables'

type Kind = 'web' | 'worker'

type PortEntry = { port: string; protocol: 'http' | 'tcp' }

export type ServicePreset = { name: string; image: string; port: PortEntry }

export function NewService({
  environment,
  preset,
  open,
  onOpenChange,
}: {
  environment: Environment
  preset?: ServicePreset
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const stations = useQuery(onlineStationsQuery)
  const project = useQuery(projectQuery(environment.project_id))
  const [name, setName] = useState(preset?.name ?? '')
  const [kind, setKind] = useState<Kind>('web')
  const [image, setImage] = useState(preset?.image ?? '')
  const ports = useRows<PortEntry>(
    [
      preset?.port ?? {
        port: '8080',
        protocol: 'http',
      },
    ],
    () => ({
      port: '',
      protocol: 'http',
    }),
  )
  const variables = useRows<VariableEntry>([], () => ({
    key: '',
    kind: 'literal',
    value: '',
    build: false,
  }))
  const [station, setStation] = useState('')
  const [deploy, setDeploy] = useState(true)
  const choices = stations.data?.items ?? []

  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .environments({
            environment: environment.id,
          })
          .services.post(
            {
              name,
              kind,
              source: {
                type: 'image',
                ref: image.trim(),
              },
              ports:
                kind === 'web'
                  ? ports.rows.map((p) => ({
                      port: Number(p.port),
                      protocol: p.protocol,
                    }))
                  : [],
              variables: variables.rows.map(toVariableInput),
              station_id: station || undefined,
              deploy_on_create: deploy,
            },
            idempotency(),
          ),
      ),
    seed: seedService,
    invalidate: ['services'],
    staged: () => `Create ${name} in ${environment.name}`,
    success: (body) => ({
      title: `${body.name} created`,
      description: body.deployments.length
        ? 'Its first deployment started.'
        : 'Deploy it from its page when you’re ready.',
    }),
    onSuccess: (result) => {
      onOpenChange(false)

      if (!result.staged) {
        void navigate({
          to: '/services/$service',
          params: {
            service: result.body.id,
          },
        })
      }
    },
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          mutation.reset()
        }

        onOpenChange(next)
      }}
      size="lg"
      title={`New service in ${environment.name}`}
      description={
        <>
          Runs a container image. For a repository or a template, use sly or a{' '}
          <Term name="manifest" />.
        </>
      }
      error={mutation.errorText}
      also={
        <AlsoWith
          cli={commands.createService({
            project: project.data?.name ?? environment.project_id,
            environment: environment.name,
          })}
          tool="create_service"
        />
      }
      submitLabel="Create service"
      pending={mutation.isPending}
      submitDisabled={choices.length > 1 && !station}
      onSubmit={() => mutation.mutate()}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field id="service-name" label="Name">
          <SlugInput
            id="service-name"
            required
            value={name}
            onValueChange={setName}
            placeholder="web"
          />
        </Field>
        <Field id="service-kind" label="Kind">
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger id="service-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="web">{serviceKind.web}</SelectItem>
              <SelectItem value="worker">{serviceKind.worker}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        id="service-image"
        label="Image"
        hint="Use a tag like nginx:1.27 or a digest. Stationly pins the tag to a digest when you create the service. Deploy picks up a newer image for the tag; Redeploy keeps the pinned one."
      >
        <Input
          id="service-image"
          required
          value={image}
          onChange={(e) => setImage(e.target.value)}
          className="font-mono"
          placeholder="traefik/whoami@sha256:…"
          spellCheck={false}
          aria-describedby={hintId('service-image')}
        />
      </Field>

      {kind === 'web' && (
        <FieldSet
          legend="Ports"
          hint="HTTP ports can have a domain. TCP ports can get a public port."
        >
          <ul className="space-y-2">
            {ports.rows.map((p, i) => (
              <li key={p.row} className="flex items-center gap-2">
                <Input
                  aria-label={`Port ${i + 1} number`}
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={p.port}
                  onChange={(e) =>
                    ports.update(p.row, {
                      port: e.target.value,
                    })
                  }
                  className="w-28 font-mono"
                />
                <Select
                  value={p.protocol}
                  onValueChange={(v) =>
                    ports.update(p.row, {
                      protocol: v as PortEntry['protocol'],
                    })
                  }
                >
                  <SelectTrigger aria-label={`Port ${i + 1} protocol`} className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="tcp">TCP</SelectItem>
                  </SelectContent>
                </Select>
                <RemoveButton
                  type="button"
                  label={`Remove port ${i + 1}`}
                  disabled={ports.rows.length === 1}
                  onClick={() => ports.remove(p.row)}
                />
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={ports.add}
          >
            <Plus /> Add port
          </Button>
        </FieldSet>
      )}

      <FieldSet legend="Variables (optional)">
        {variables.rows.length > 0 && (
          <ul className="space-y-2">
            {variables.rows.map((v, i) => (
              <li
                key={v.row}
                className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 sm:grid-cols-[10rem_7rem_1fr_auto]"
              >
                <VariableKeyInput
                  aria-label={`Variable ${i + 1} key`}
                  value={v.key}
                  onValueChange={(key) =>
                    variables.update(v.row, {
                      key,
                    })
                  }
                  placeholder="KEY"
                />
                <VariableKindSelect
                  label={`Variable ${i + 1} kind`}
                  value={v.kind}
                  onValueChange={(kind) =>
                    variables.update(v.row, {
                      kind,
                    })
                  }
                />
                <VariableValueInput
                  kind={v.kind}
                  label={`Variable ${i + 1} ${v.kind === 'reference' ? 'reference' : 'value'}`}
                  value={v.value}
                  onValueChange={(value) =>
                    variables.update(v.row, {
                      value,
                    })
                  }
                  placeholder="value"
                  className="col-span-2 sm:col-span-1"
                />
                <RemoveButton
                  type="button"
                  label={`Remove variable ${i + 1}`}
                  className="col-start-3 row-start-1 sm:col-start-4"
                  onClick={() => variables.remove(v.row)}
                />
                <CheckboxField
                  id={`variable-${v.row}-build`}
                  className="col-span-full"
                  checked={v.build}
                  onCheckedChange={(build) =>
                    variables.update(v.row, {
                      build,
                    })
                  }
                  label="Available at build time"
                  labelClassName="text-xs text-muted-foreground"
                />
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={variables.add}
        >
          <Plus /> Add variable
        </Button>
        <VariableNotes
          sealed={variables.rows.some((v) => v.kind === 'sealed')}
          build={variables.rows.some((v) => v.build)}
        />
      </FieldSet>

      {choices.length > 1 && (
        <Field id="service-station" label="Station">
          <Select value={station} onValueChange={setStation}>
            <SelectTrigger id="service-station" className="w-full">
              <SelectValue placeholder="Choose a station" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <CheckboxField
        id="service-deploy"
        checked={deploy}
        onCheckedChange={setDeploy}
        label="Deploy when created"
      />
    </FormDialog>
  )
}
