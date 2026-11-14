import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUp, Cpu, HardDrive, Loader2, MemoryStick, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'

import {
  fitSandboxMemory,
  modelLabel,
  workspaceAgents,
  workspaceSizeDefaults,
  type WorkspaceAgent,
} from '@stationly/protocol'

import { CredentialField } from '@/components/credential-field'
import { EmptyState } from '@/components/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { failureText } from '@/lib/api'
import { byName, bytes, repositoryName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { readLastTask, writeLastTask } from '@/lib/last-task'
import {
  credentialKey,
  githubTokenHelp,
  githubTokenKey,
  githubTokenLabel,
  missingCredential,
  needsGithubToken,
  repositoryUrl,
  taskSentence,
} from '@/lib/new-task'
import {
  environmentsQuery,
  projectsQuery,
  projectVariablesQuery,
  sandboxesQuery,
  taskStationQuery,
} from '@/lib/queries'
import { startTask, storeProjectKey } from '@/lib/start-task'

const agents = (Object.keys(workspaceAgents) as WorkspaceAgent[]).filter(
  (agent) => workspaceAgents[agent].runner,
)

const chip =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground tabular-nums'

export function NewTask() {
  const navigate = useNavigate()
  const { data: projects } = useSuspenseQuery(projectsQuery)
  const last = readLastTask()
  const sorted = [...projects.items].sort(byName)
  const [projectId, setProjectId] = useState(
    sorted.find((project) => project.id === last?.project)?.id ?? sorted[0]?.id ?? '',
  )
  const project = sorted.find((candidate) => candidate.id === projectId)
  const { data: environments } = useQuery({
    ...environmentsQuery(project?.name ?? ''),
    enabled: Boolean(project),
  })
  const [environmentChoice, setEnvironmentChoice] = useState(last?.environment ?? '')
  const environment =
    environments?.items.find((candidate) => candidate.id === environmentChoice) ??
    environments?.items.find((candidate) => candidate.id === project?.default_environment_id) ??
    environments?.items[0]
  const [agent, setAgent] = useState<WorkspaceAgent>(agents[0] ?? 'claude')
  const preset = workspaceAgents[agent]
  const [model, setModel] = useState<string>(preset.models[0]?.id ?? '')
  const [repository, setRepository] = useState(last?.repository ?? '')
  const [prompt, setPrompt] = useState('')
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [githubAsked, setGithubAsked] = useState(false)
  const [options, setOptions] = useState(false)
  const [reuse, setReuse] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')
  const url = repositoryUrl(repository)
  const variables = useQuery({
    ...projectVariablesQuery(project?.id ?? '', environment?.name ?? ''),
    enabled: Boolean(project && environment),
  })
  const { data: station } = useQuery(taskStationQuery)
  const { data: sandboxes } = useQuery({
    ...sandboxesQuery(environment?.id ?? ''),
    enabled: Boolean(environment),
  })
  const workspaces = (sandboxes?.items ?? []).filter(
    (candidate) =>
      candidate.workspace?.agent === agent &&
      (candidate.status === 'running' || candidate.status === 'stopped') &&
      (!url || candidate.workspace.repository === url),
  )
  const reused = reuse ? workspaces.find((candidate) => candidate.id === workspaceId) : undefined
  const needsKey =
    variables.data !== undefined &&
    missingCredential(
      preset.keys,
      variables.data.items.map((variable) => variable.key),
    )
  const keyName = credentialKey(preset.keys, key)
  const fitted = fitSandboxMemory(
    station?.sandbox_memory?.free ?? null,
    workspaceSizeDefaults.memory_bytes,
  )
  const create = useMutation({
    mutationFn: async () => {
      if (!project || !environment || !url) {
        throw new Error('Choose a project, an environment and a repository first.')
      }

      const scope = {
        project: project.id,
        environment: environment.name,
      }

      if (needsKey) {
        await storeProjectKey(scope, keyName, key)
      }

      if (githubAsked && githubToken.trim()) {
        await storeProjectKey(scope, githubTokenKey, githubToken)
      }

      if (needsKey || githubAsked) {
        await queryClient.invalidateQueries({
          queryKey: ['variables'],
        })
      }

      return startTask({
        environment: environment.id,
        agent,
        repository: url,
        prompt: prompt.trim(),
        model,
        memory: fitted,
        workspace: reused?.id,
      })
    },
    onError: (error) => setGithubAsked(needsGithubToken(error)),
    onSuccess: (session) => {
      writeLastTask({
        project: project?.id ?? null,
        environment: environment?.id ?? null,
        repository: url ?? repository,
      })
      void navigate({
        to: '/sessions/$sandbox/$session',
        params: {
          sandbox: session.sandbox.id,
          session: session.session_id,
        },
      })
    },
  })
  const ready =
    Boolean(prompt.trim() && url && project && environment) &&
    (!needsKey || key.trim() !== '') &&
    (!githubAsked || githubToken.trim() !== '') &&
    (!reuse || Boolean(reused))
  const submit = () => {
    if (ready && !create.isPending) {
      create.mutate()
    }
  }
  const stationMemory = station?.sandbox_memory

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.project}
        title="Create a project first"
        description="A task runs in a workspace, and a workspace belongs to a project."
        action={
          <Button asChild>
            <Link to="/projects">Go to projects</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="mx-auto flex min-h-[60svh] max-w-2xl flex-col justify-center gap-4 py-10">
      <h1 className="text-center text-3xl font-semibold tracking-tight">What should run?</h1>
      <div className="space-y-3 rounded-2xl border bg-card p-3">
        {needsKey && (
          <CredentialField
            label={preset.keyLabel}
            project={project?.name ?? ''}
            value={key}
            onChange={setKey}
            help={`${project?.name} has no ${preset.keyLabel.toLowerCase()}. ${preset.keyHelp} Stationly stores it sealed for the whole project.`}
          />
        )}
        {githubAsked && (
          <CredentialField
            label={githubTokenLabel}
            project={project?.name ?? ''}
            value={githubToken}
            onChange={setGithubToken}
            help={githubTokenHelp(project?.name ?? '', repositoryName(url ?? repository))}
          />
        )}
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Describe the task. It runs in a repository on one of your stations."
          aria-label="Describe the task"
          className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={agent}
            onValueChange={(value) => {
              const next = value as WorkspaceAgent

              setAgent(next)
              setModel(workspaceAgents[next].models[0]?.id ?? '')
            }}
          >
            <SelectTrigger size="sm" aria-label="Agent" className="border-0 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((name) => (
                <SelectItem key={name} value={name}>
                  {workspaceAgents[name].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger size="sm" aria-label="Model" className="border-0 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {preset.models.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {modelLabel(entry.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            list="task-repositories"
            placeholder="owner/name or an https URL"
            aria-label="Repository"
            aria-invalid={repository !== '' && !url}
            className="h-8 w-56 font-mono text-xs"
          />
          <datalist id="task-repositories">
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={repositoryName(workspace.workspace!.repository)}>
                {workspace.name}
              </option>
            ))}
          </datalist>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Options"
            aria-expanded={options}
            onClick={() => setOptions((open) => !open)}
          >
            <SlidersHorizontal />
          </Button>
          <Button
            size="icon"
            className="ml-auto rounded-full"
            aria-label="Start the task"
            disabled={!ready || create.isPending}
            onClick={submit}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
        {options && (
          <div className="grid gap-3 border-t px-1 pt-3 sm:grid-cols-2">
            <Select
              value={project?.id ?? ''}
              onValueChange={(value) => {
                setProjectId(value)
                setEnvironmentChoice('')
                setWorkspaceId('')
              }}
            >
              <SelectTrigger size="sm" aria-label="Project">
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={environment?.id ?? ''}
              onValueChange={(value) => {
                setEnvironmentChoice(value)
                setWorkspaceId('')
              }}
            >
              <SelectTrigger size="sm" aria-label="Environment">
                <SelectValue placeholder="Environment" />
              </SelectTrigger>
              <SelectContent>
                {(environments?.items ?? []).map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={reuse} onCheckedChange={setReuse} />
              Use a workspace of this repository
            </label>
            {reuse && (
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger size="sm" aria-label="Workspace" className="sm:col-span-2">
                  <SelectValue placeholder={workspaces.length ? 'Pick a workspace' : 'None yet'} />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {taskSentence({
          agent: preset.label,
          station: station?.name ?? null,
          workspace: reused?.name ?? null,
        })}
      </p>
      {station && (
        <div className="flex flex-wrap justify-center gap-2" aria-label="Station resources">
          {station.resources && (
            <span className={chip}>
              <Cpu className="size-3" aria-hidden />
              {station.resources.cpu_millis / 1000} cores
            </span>
          )}
          {stationMemory && (
            <span className={chip}>
              <MemoryStick className="size-3" aria-hidden />
              {bytes(stationMemory.used)}
              {stationMemory.limit !== null && ` of ${bytes(stationMemory.limit)}`} sandbox memory
            </span>
          )}
          {station.resources && (
            <span className={chip}>
              <HardDrive className="size-3" aria-hidden />
              {bytes(station.resources.disk_free_bytes)} free
            </span>
          )}
        </div>
      )}
      {create.isError && (
        <Alert variant="destructive">
          <AlertDescription>{failureText(create.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
