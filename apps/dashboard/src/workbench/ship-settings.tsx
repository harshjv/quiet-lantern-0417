import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Clock, Settings, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Confirm } from '@/components/confirm'
import { CheckboxField, Field, Suffixed } from '@/components/field'
import { FormDialog, FormError } from '@/components/form-dialog'
import { Panel } from '@/components/panel'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, idempotency, send, type Me, type Preview } from '@/lib/api'
import { placeTo } from '@/lib/links'
import { useApiMutation } from '@/lib/mutation'
import type { PlaceView } from '@/lib/place'
import { meQuery, projectSettingsQuery } from '@/lib/queries'

import { Section } from './parts'

const gib = 1024 ** 3

const lifetimes = [
  {
    value: '3600',
    label: 'One hour from now',
  },
  {
    value: '86400',
    label: 'One day from now',
  },
  {
    value: '604800',
    label: 'One week from now',
  },
  {
    value: '2592000',
    label: 'Thirty days from now',
  },
  {
    value: 'never',
    label: 'Never',
  },
] as const

const canAdmin = (me: Me | undefined, project: string) =>
  (me?.scopes ?? []).some(
    (scope) =>
      scope.level === 'admin' && (scope.project_id === '*' || scope.project_id === project),
  )

export function ProjectSettings({ project }: { project: string }) {
  return (
    <Panel rows={5} title="Couldn’t load the project settings">
      <ProjectSettingsForm project={project} />
    </Panel>
  )
}

type Draft = {
  manifest: string
  cache: string
  retention: string
  rebuild: boolean
  pullRequests: boolean
}

const changesOf = (saved: Draft, draft: Draft) => ({
  ...(draft.manifest !== saved.manifest && {
    manifest_path: draft.manifest.trim() || null,
  }),
  ...(draft.cache !== saved.cache && {
    build_cache_bytes: Math.round(Number(draft.cache) * gib),
  }),
  ...(draft.retention !== saved.retention && {
    image_retention_count: Number(draft.retention),
  }),
  ...(draft.rebuild !== saved.rebuild && {
    base_image_auto_rebuild: draft.rebuild,
  }),
  ...(draft.pullRequests !== saved.pullRequests && {
    pull_request_previews: draft.pullRequests,
  }),
})

function ProjectSettingsForm({ project }: { project: string }) {
  const { data } = useSuspenseQuery(projectSettingsQuery(project))
  const me = useQuery(meQuery)
  const admin = canAdmin(me.data, data.id)
  const saved: Draft = {
    manifest: data.manifest_path ?? '',
    cache: String(Math.round(((data.build_cache_bytes ?? 0) / gib) * 10) / 10),
    retention: String(data.image_retention_count ?? 1),
    rebuild: data.base_image_auto_rebuild ?? false,
    pullRequests: data.pull_request_previews ?? false,
  }
  const [draft, setDraft] = useState(saved)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
  const dirty = (Object.keys(saved) as (keyof Draft)[]).some((key) => saved[key] !== draft[key])
  const save = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({
            project: data.id,
          })
          .patch(changesOf(saved, draft), idempotency()),
      ),
    invalidate: ['projects'],
    success: () => `${data.name} settings saved`,
  })

  return (
    <div className="flex flex-col gap-8">
      <Section
        icon={Settings}
        title="Project settings"
        note={
          admin
            ? 'These apply to the whole project, production and previews.'
            : 'Only an admin of this project changes its settings.'
        }
      >
        <form
          className="flex max-w-xl flex-col gap-4 border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <fieldset disabled={!admin || save.isPending} className="flex flex-col gap-4">
            <Field
              id="project-manifest"
              label="Manifest path"
              hint="Where the Manifest lives in the connected repository."
            >
              <Input
                id="project-manifest"
                value={draft.manifest}
                onChange={(event) => set('manifest', event.target.value)}
                placeholder="stationly.yaml"
                className="font-mono"
              />
            </Field>
            <Field
              id="project-cache"
              label="Build cache"
              hint="How much the project’s builds keep cached between builds."
            >
              <Suffixed suffix="GiB">
                <Input
                  id="project-cache"
                  type="number"
                  min={0}
                  step={0.5}
                  required
                  value={draft.cache}
                  onChange={(event) => set('cache', event.target.value)}
                />
              </Suffixed>
            </Field>
            <Field
              id="project-retention"
              label="Images kept per app"
              hint="Older images go, except those of running deployments. Rolling back needs the image."
            >
              <Input
                id="project-retention"
                type="number"
                min={1}
                step={1}
                required
                value={draft.retention}
                onChange={(event) => set('retention', event.target.value)}
              />
            </Field>
            <CheckboxField
              id="project-rebuild"
              checked={draft.rebuild}
              onCheckedChange={(value) => set('rebuild', value)}
              label="Rebuild and deploy when a base image changes"
              hint="When the image an app builds from gets a new digest."
            />
            <CheckboxField
              id="project-pull-requests"
              checked={draft.pullRequests}
              onCheckedChange={(value) => set('pullRequests', value)}
              label="Give each pull request a preview"
              hint="A pull request on a connected repository gets its own preview."
            />
          </fieldset>
          {save.errorText && <FormError>{save.errorText}</FormError>}
          {admin && (
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
                Save settings
              </Button>
              {dirty && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(saved)}>
                  Discard changes
                </Button>
              )}
            </div>
          )}
        </form>
      </Section>
      {admin && !data.shared && <DeleteProject id={data.id} name={data.name} />}
    </div>
  )
}

function DeleteProject({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const navigate = useNavigate()
  const remove = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .projects({
            project: id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['projects'],
    success: () => `${name} deleted`,
    onSuccess: () => {
      setOpen(false)
      void navigate({
        to: '/projects',
      })
    },
  })

  return (
    <DangerZone
      title="Delete this project"
      text="Deletes the project, its production and its environment variables. It must have no previews, apps or machines left."
    >
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)

          if (!next) {
            setTyped('')
            remove.reset()
          }
        }}
        trigger={
          <Button size="sm" variant="destructive">
            Delete project
          </Button>
        }
        title={`Delete ${name}?`}
        description="This cannot be undone. Delete its previews, apps and machines first."
        error={remove.errorText}
        submitLabel="Delete project"
        submitVariant="destructive"
        submitDisabled={typed !== name}
        pending={remove.isPending}
        onSubmit={() => remove.mutate()}
      >
        <Field id="delete-project-name" label={`Type ${name} to confirm`}>
          <Input
            id="delete-project-name"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </FormDialog>
    </DangerZone>
  )
}

function DangerZone({
  title,
  text,
  children,
}: {
  title: string
  text: string
  children: ReactNode
}) {
  return (
    <Section icon={TriangleAlert} title="Danger zone">
      <div className="flex max-w-xl flex-wrap items-center justify-between gap-4 border border-destructive/40 p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
        {children}
      </div>
    </Section>
  )
}

export function PreviewSettings({ place, preview }: { place: PlaceView; preview: Preview }) {
  const [lifetime, setLifetime] = useState<string>(preview.expires_at ? '604800' : 'never')
  const expire = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .previews({
            preview: preview.id,
          })
          .patch(
            {
              ttl_seconds: lifetime === 'never' ? null : Number(lifetime),
            },
            idempotency(),
          ),
      ),
    invalidate: ['previews'],
    success: () =>
      lifetime === 'never' ? `${preview.name} no longer expires` : `${preview.name} expiry set`,
  })
  const navigate = useNavigate()
  const remove = useApiMutation({
    mutationFn: () =>
      send(
        api.v1
          .previews({
            preview: preview.id,
          })
          .delete(undefined, idempotency()),
      ),
    invalidate: ['previews'],
    success: () => `${preview.name} deleted`,
    onSuccess: () => void navigate(placeTo(place.projectName, null, 'previews')),
  })

  return (
    <div className="flex flex-col gap-8">
      <Section icon={Clock} title="Expiry">
        <form
          className="flex max-w-xl flex-col gap-4 border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            expire.mutate()
          }}
        >
          <p className="text-sm">
            {preview.expires_at ? (
              <>
                Stationly deletes this preview at <Time value={preview.expires_at} />.
              </>
            ) : (
              'This preview never expires.'
            )}
          </p>
          <Field id="preview-lifetime" label="Expires">
            <Select value={lifetime} onValueChange={setLifetime}>
              <SelectTrigger id="preview-lifetime" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lifetimes.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {expire.errorText && <FormError>{expire.errorText}</FormError>}
          <div>
            <Button type="submit" size="sm" disabled={expire.isPending}>
              Set expiry
            </Button>
          </div>
        </form>
      </Section>
      <DangerZone
        title="Delete this preview"
        text="Deletes its apps and its network. Its volumes are kept for a while. Delete its machines first."
      >
        <Confirm
          title={`Delete ${preview.name}?`}
          description={`Deletes ${preview.name} with its apps and network. Production does not change.`}
          action="Delete preview"
          onConfirm={() => remove.mutateAsync()}
          trigger={
            <Button size="sm" variant="destructive">
              Delete preview
            </Button>
          }
        />
      </DangerZone>
    </div>
  )
}
