import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { AlsoWith, CodeInput } from '@/components/code'
import { RemoveButton } from '@/components/confirm'
import { CheckboxField, Field, FieldSet, hintId } from '@/components/field'
import { FormDialog } from '@/components/form-dialog'
import { SlugInput } from '@/components/slug-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  VariableKindSelect,
  VariableNameInput,
  VariableNotes,
  VariableValueInput,
} from '@/components/variable-fields'
import { api, idempotency, send } from '@/lib/api'
import { commands } from '@/lib/commands'
import { appKind } from '@/lib/labels'
import { appTo } from '@/lib/links'
import { useApiMutation } from '@/lib/mutation'
import { appRepository } from '@/lib/new-task'
import { placeName, previewQuery, scopeOf, type PlaceView } from '@/lib/place'
import { myRepositoriesQuery, onlineStationsQuery, seedApp } from '@/lib/queries'
import { useRows } from '@/lib/use-rows'
import { toVariableInput, type VariableEntry } from '@/lib/variables'

type Kind = 'web' | 'worker'

type SourceChoice = 'image' | 'repository'

type Builder = 'dockerfile' | 'railpack'

type PortEntry = { port: string; protocol: 'http' | 'tcp' }

export type AppPreset = { name: string; image: string; port: PortEntry }

export function NewApp({
  place,
  preset,
  open,
  onOpenChange,
}: {
  place: PlaceView
  preset?: AppPreset
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stations = useQuery(onlineStationsQuery)
  const [name, setName] = useState(preset?.name ?? '')
  const [kind, setKind] = useState<Kind>('web')
  const [choice, setChoice] = useState<SourceChoice>('image')
  const [image, setImage] = useState(preset?.image ?? '')
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [builder, setBuilder] = useState<Builder>('dockerfile')
  const [folder, setFolder] = useState('')
  const [dockerfile, setDockerfile] = useState('')
  const reachable = useQuery({
    ...myRepositoriesQuery,
    enabled: open && choice === 'repository',
  })
  const repo = appRepository(repository)
  const picked = (reachable.data?.items ?? []).find(
    (r) => `github.com/${r.full_name.toLowerCase()}` === repo,
  )
  const tracked = branch.trim() || picked?.default_branch || ''
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
    name: '',
    kind: 'literal',
    value: '',
    build: false,
  }))
  const [station, setStation] = useState('')
  const [deploy, setDeploy] = useState(true)
  const choices = stations.data?.items ?? []

  const navigate = useNavigate()
  const mutation = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({
            project: place.project,
          })
          .apps.post(
            {
              name,
              kind,
              source:
                choice === 'image'
                  ? {
                      type: 'image',
                      ref: image.trim(),
                    }
                  : builder === 'dockerfile'
                    ? {
                        type: 'dockerfile',
                        repo: repo!,
                        branch: tracked,
                        path: folder.trim() || undefined,
                        dockerfile: dockerfile.trim() || undefined,
                      }
                    : {
                        type: 'railpack',
                        repo: repo!,
                        branch: tracked,
                        path: folder.trim() || undefined,
                      },
              ports:
                kind === 'web'
                  ? ports.rows.map((p) => ({
                      port: Number(p.port),
                      protocol: p.protocol,
                    }))
                  : [],
              environment_variables: variables.rows.map(toVariableInput),
              server_id: station || undefined,
              deploy_on_create: deploy,
            },
            {
              ...idempotency(),
              query: previewQuery(place),
            },
          ),
      ),
    seed: seedApp,
    invalidate: ['apps'],
    waiting: () => `Create ${name} in ${placeName(place)}`,
    success: (body) => ({
      title: `Created ${body.name}`,
      description: body.deployments.length ? 'First deployment started.' : undefined,
    }),
    onSuccess: (result) => {
      onOpenChange(false)

      if (!result.waiting) {
        void navigate(appTo(place.projectName, result.body.id))
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
      title={`New app in ${placeName(place)}`}
      error={mutation.errorText}
      also={<AlsoWith cli={commands.createApp(scopeOf(place), choice)} tool="create_app" />}
      submitLabel="Create app"
      pending={mutation.isPending}
      submitDisabled={
        (choices.length > 1 && !station) || (choice === 'repository' && (!repo || !tracked))
      }
      onSubmit={() => mutation.mutate()}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field id="app-name" label="Name">
          <SlugInput
            id="app-name"
            required
            value={name}
            onValueChange={setName}
            placeholder="web"
          />
        </Field>
        <Field id="app-kind" label="Kind">
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger id="app-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="web">{appKind.web}</SelectItem>
              <SelectItem value="worker">{appKind.worker}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <FieldSet legend="Source">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          className="self-start"
          value={choice}
          onValueChange={(v) => v && setChoice(v as SourceChoice)}
        >
          <ToggleGroupItem value="image" className="min-w-28">
            Image
          </ToggleGroupItem>
          <ToggleGroupItem value="repository" className="min-w-28">
            GitHub repository
          </ToggleGroupItem>
        </ToggleGroup>
      </FieldSet>

      {choice === 'image' ? (
        <Field
          id="app-image"
          label="Image"
          hint="A tag or a digest. Stationly pins a tag to its digest."
        >
          <CodeInput
            id="app-image"
            required
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="traefik/whoami@sha256:…"
            aria-describedby={hintId('app-image')}
          />
        </Field>
      ) : (
        <RepositoryFields
          items={reachable.data?.items ?? []}
          defaultBranch={picked?.default_branch}
          repository={repository}
          onRepository={setRepository}
          invalid={repository.trim() !== '' && !repo}
          branch={branch}
          onBranch={setBranch}
          builder={builder}
          onBuilder={setBuilder}
          folder={folder}
          onFolder={setFolder}
          dockerfile={dockerfile}
          onDockerfile={setDockerfile}
        />
      )}

      {kind === 'web' && (
        <FieldSet
          legend="Ports"
          hint="HTTP ports take a domain. TCP ports stay inside the network."
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
                  className="w-28 tabular-nums"
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

      <FieldSet legend="Environment variables (optional)">
        {variables.rows.length > 0 && (
          <ul className="space-y-2">
            {variables.rows.map((v, i) => (
              <li
                key={v.row}
                className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 sm:grid-cols-[10rem_7rem_1fr_auto]"
              >
                <VariableNameInput
                  aria-label={`Environment variable ${i + 1} name`}
                  value={v.name}
                  onValueChange={(name) =>
                    variables.update(v.row, {
                      name,
                    })
                  }
                  placeholder="KEY"
                />
                <VariableKindSelect
                  label={`Environment variable ${i + 1} kind`}
                  value={v.kind}
                  onValueChange={(kind) =>
                    variables.update(v.row, {
                      kind,
                    })
                  }
                />
                <VariableValueInput
                  kind={v.kind}
                  label={`Environment variable ${i + 1} ${v.kind === 'reference' ? 'reference' : 'value'}`}
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
                  label={`Remove environment variable ${i + 1}`}
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
          <Plus /> Add environment variable
        </Button>
        <VariableNotes
          secret={variables.rows.some((v) => v.kind === 'secret')}
          build={variables.rows.some((v) => v.build)}
        />
      </FieldSet>

      {choices.length > 1 && (
        <Field id="app-station" label="Server">
          <Select value={station} onValueChange={setStation}>
            <SelectTrigger id="app-station" className="w-full">
              <SelectValue placeholder="Choose a server" />
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
        id="app-deploy"
        checked={deploy}
        onCheckedChange={setDeploy}
        label="Deploy when created"
      />
    </FormDialog>
  )
}

function RepositoryFields({
  items,
  defaultBranch,
  repository,
  onRepository,
  invalid,
  branch,
  onBranch,
  builder,
  onBuilder,
  folder,
  onFolder,
  dockerfile,
  onDockerfile,
}: {
  items: { full_name: string; default_branch: string }[]
  defaultBranch: string | undefined
  repository: string
  onRepository: (value: string) => void
  invalid: boolean
  branch: string
  onBranch: (value: string) => void
  builder: Builder
  onBuilder: (value: Builder) => void
  folder: string
  onFolder: (value: string) => void
  dockerfile: string
  onDockerfile: (value: string) => void
}) {
  return (
    <>
      <Field id="app-repository" label="Repository" hint="owner/name or a github.com URL.">
        <CodeInput
          id="app-repository"
          required
          list="app-repositories"
          value={repository}
          onChange={(e) => onRepository(e.target.value)}
          placeholder="owner/name"
          aria-invalid={invalid}
          aria-describedby={hintId('app-repository')}
        />
        <datalist id="app-repositories">
          {items.map((r) => (
            <option key={r.full_name} value={r.full_name}>
              {r.default_branch}
            </option>
          ))}
        </datalist>
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
        <Field
          id="app-branch"
          label="Branch"
          hint={
            defaultBranch
              ? `Every push to it deploys. ${defaultBranch} when empty.`
              : 'Every push to it deploys.'
          }
        >
          <CodeInput
            id="app-branch"
            required={!defaultBranch}
            value={branch}
            onChange={(e) => onBranch(e.target.value)}
            placeholder={defaultBranch ?? 'main'}
            aria-describedby={hintId('app-branch')}
          />
        </Field>
        <Field id="app-builder" label="Build with">
          <Select value={builder} onValueChange={(v) => onBuilder(v as Builder)}>
            <SelectTrigger id="app-builder" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dockerfile">Its Dockerfile</SelectItem>
              <SelectItem value="railpack">Railpack</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="app-folder"
          label="Folder (optional)"
          hint="Where the build starts inside the repository."
        >
          <CodeInput
            id="app-folder"
            value={folder}
            onChange={(e) => onFolder(e.target.value)}
            placeholder="/"
            pattern="/.*"
            aria-describedby={hintId('app-folder')}
          />
        </Field>
        {builder === 'dockerfile' && (
          <Field id="app-dockerfile" label="Dockerfile (optional)" hint="Relative to the folder.">
            <CodeInput
              id="app-dockerfile"
              value={dockerfile}
              onChange={(e) => onDockerfile(e.target.value)}
              placeholder="Dockerfile"
              aria-describedby={hintId('app-dockerfile')}
            />
          </Field>
        )}
      </div>
    </>
  )
}
