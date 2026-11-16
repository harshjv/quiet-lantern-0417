import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, ExternalLink, GitBranch, KeyRound, Rocket, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, failureText, idempotency, unwrap, type Deployment } from '@/lib/api'
import { shortAgo } from '@/lib/format'
import {
  deploymentsQuery,
  diagnosisQuery,
  logsQuery,
  projectVariablesQuery,
  serviceQuery,
} from '@/lib/queries'

import type { Place } from './app'
import {
  appLink,
  failedApps,
  healthText,
  healthTone,
  useLiveApps,
  useLiveEnvironments,
  useLiveProjects,
  type LiveApp,
} from './ops-live'
import { ItemList, ItemRow, Notice, Page, Section, StatusPill } from './parts'

type Go = (next: Partial<Place>) => void

type Tab = 'production' | 'previews' | 'keys'

const deploymentTone = (status: Deployment['status']) =>
  status === 'active'
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : status === 'cancelled' || status === 'superseded'
        ? 'neutral'
        : 'warning'

const fixOf = (app: LiveApp) =>
  app.newest?.status === 'failed' ? `deployment:${app.newest.id}` : `service:${app.service.id}`

export function LiveShip({ place, go }: { place: Place; go: Go }) {
  const [tab, setTab] = useState<Tab>('production')

  if (place.view?.startsWith('app:')) {
    return <LiveAppPage serviceId={place.view.slice(4)} go={go} />
  }

  return (
    <Page title="Ship">
      <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
        <TabsList>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="previews">Previews</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'production' && <Production scope={place.project} go={go} />}
      {tab === 'previews' && <Previews scope={place.project} />}
      {tab === 'keys' && <Keys scope={place.project} />}
    </Page>
  )
}

function Production({ scope, go }: { scope: string | null; go: Go }) {
  const apps = useLiveApps(scope)
  const failed = failedApps(apps)

  return (
    <>
      {failed.map((app) => (
        <Notice
          key={app.service.id}
          tone="danger"
          title={`${app.service.name}: the last deploy failed`}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {app.newest?.failure?.summary ?? 'The deployment did not become healthy.'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                go({
                  view: `app:${app.service.id}`,
                })
              }
            >
              Open
            </Button>
            <Button
              size="sm"
              onClick={() =>
                go({
                  mode: 'build',
                  view: 'fix',
                  fix: fixOf(app),
                })
              }
            >
              Fix with an agent
            </Button>
          </span>
        </Notice>
      ))}
      <Section title="Apps" count={apps.length}>
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No apps in production yet.</p>
        ) : (
          <ItemList>
            {apps.map((app) => (
              <ItemRow
                key={app.service.id}
                icon={Box}
                tone={healthTone[app.service.status]}
                title={
                  <>
                    {app.service.name}
                    <StatusPill tone={healthTone[app.service.status]}>
                      {healthText[app.service.status]}
                    </StatusPill>
                  </>
                }
                meta={[
                  {
                    kind: 'project',
                    text: `${app.environment.project.name} / ${app.environment.name}`,
                  },
                  ...(app.newest
                    ? [
                        {
                          kind: 'version' as const,
                          text: `#${app.newest.number} ${app.newest.status}`,
                        },
                      ]
                    : []),
                  ...(appLink(app.service)
                    ? [
                        {
                          kind: 'link' as const,
                          text: appLink(app.service)!,
                        },
                      ]
                    : []),
                ]}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      go({
                        view: `app:${app.service.id}`,
                      })
                    }
                  >
                    Open
                  </Button>
                }
              />
            ))}
          </ItemList>
        )}
      </Section>
    </>
  )
}

function Previews({ scope }: { scope: string | null }) {
  const previews = useLiveEnvironments(useLiveProjects(scope)).filter(
    (environment) => environment.ephemeral,
  )

  return (
    <Section title="Previews" count={previews.length}>
      {previews.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No previews. Make a preview from a task, or open a pull request on a connected repository.
        </p>
      ) : (
        <ItemList>
          {previews.map((environment) => (
            <ItemRow
              key={environment.id}
              icon={GitBranch}
              title={environment.name}
              meta={[
                {
                  kind: 'project',
                  text: environment.project.name,
                },
                ...(environment.pull_request
                  ? [
                      {
                        kind: 'branch' as const,
                        text: `${environment.pull_request.repo}#${environment.pull_request.number}`,
                      },
                    ]
                  : []),
              ]}
            />
          ))}
        </ItemList>
      )}
    </Section>
  )
}

function Keys({ scope }: { scope: string | null }) {
  const projects = useLiveProjects(scope)
  const environments = useLiveEnvironments(projects).filter((environment) => !environment.ephemeral)

  return (
    <>
      {environments.map((environment) => (
        <EnvironmentKeys
          key={environment.id}
          project={environment.project}
          environment={environment}
        />
      ))}
    </>
  )
}

function EnvironmentKeys({
  project,
  environment,
}: {
  project: { id: string; name: string }
  environment: { id: string; name: string }
}) {
  const variables = useQuery(projectVariablesQuery(project.id, environment.id))
  const items = (variables.data?.items ?? []) as { key: string; kind: string }[]

  return (
    <Section
      title={`${project.name} keys`}
      count={items.length}
      note="Keys every app and task of the project receives. Change them in the project settings."
    >
      <ItemList>
        {items.map((variable) => (
          <ItemRow
            key={variable.key}
            icon={KeyRound}
            title={<span className="font-mono text-sm">{variable.key}</span>}
            meta={[
              {
                kind: 'status',
                text: variable.kind === 'sealed' ? 'Sealed' : variable.kind,
              },
            ]}
          />
        ))}
      </ItemList>
    </Section>
  )
}

function LiveAppPage({ serviceId, go }: { serviceId: string; go: Go }) {
  const queries = useQueryClient()
  const service = useQuery(serviceQuery(serviceId))
  const deployments = useQuery(deploymentsQuery(serviceId))
  const items = deployments.data?.items ?? []
  const newest = items[0]
  const failed = newest?.status === 'failed' ? newest : undefined
  const diagnosis = useQuery({
    ...diagnosisQuery(failed?.id ?? ''),
    enabled: Boolean(failed),
  })
  const logs = useQuery({
    ...logsQuery({
      service: serviceId,
    }),
    enabled: Boolean(service.data),
  })
  const [problem, setProblem] = useState<string | null>(null)
  const refresh = () => {
    void queries.invalidateQueries({
      queryKey: ['deployments', 'of', serviceId],
    })
    void queries.invalidateQueries({
      queryKey: ['services', serviceId],
    })
  }
  const redeploy = useMutation({
    mutationFn: () =>
      unwrap(
        api.v1
          .services({
            service: serviceId,
          })
          .redeploy.post({}, idempotency()),
      ),
    onSuccess: refresh,
    onError: (error) => setProblem(failureText(error)),
  })
  const rollback = useMutation({
    mutationFn: (deployment: string) =>
      unwrap(
        api.v1
          .services({
            service: serviceId,
          })
          .rollback.post(
            {
              deployment_id: deployment,
            },
            idempotency(),
          ),
      ),
    onSuccess: refresh,
    onError: (error) => setProblem(failureText(error)),
  })

  if (!service.data) {
    return null
  }

  const link = appLink(service.data)

  return (
    <Page
      title={service.data.name}
      actions={
        <span className="flex gap-2">
          {link && (
            <Button asChild size="sm" variant="outline">
              <a href={link} target="_blank" rel="noreferrer">
                <ExternalLink /> Open
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={redeploy.isPending}
            onClick={() => redeploy.mutate()}
          >
            <Rocket /> Redeploy
          </Button>
        </span>
      }
    >
      <span className="flex items-center gap-2 text-sm">
        <StatusPill tone={healthTone[service.data.status]}>
          {healthText[service.data.status]}
        </StatusPill>
        <span className="text-muted-foreground">{service.data.kind}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            go({
              view: null,
            })
          }
        >
          Back to Ship
        </Button>
      </span>
      {problem && (
        <Notice tone="danger" title="That did not go through">
          {problem}
        </Notice>
      )}
      {failed && (
        <Notice tone="danger" title={`Deployment #${failed.number} failed`}>
          <span className="flex flex-col gap-2">
            <span>
              {diagnosis.data?.summary ?? failed.failure?.summary ?? 'The deployment failed.'}
            </span>
            {(diagnosis.data?.fixes ?? []).map((fix) => (
              <span key={fix.code} className="text-sm">
                {fix.text}
              </span>
            ))}
            <span>
              <Button
                size="sm"
                onClick={() =>
                  go({
                    mode: 'build',
                    view: 'fix',
                    fix: `deployment:${failed.id}`,
                  })
                }
              >
                <TriangleAlert /> Fix with an agent
              </Button>
            </span>
          </span>
        </Notice>
      )}
      <Section title="Deploys" count={items.length}>
        <ItemList>
          {items.slice(0, 20).map((deployment) => (
            <ItemRow
              key={deployment.id}
              icon={Rocket}
              tone={deploymentTone(deployment.status)}
              title={
                <>
                  #{deployment.number}
                  <StatusPill tone={deploymentTone(deployment.status)}>
                    {deployment.status}
                  </StatusPill>
                </>
              }
              meta={[
                {
                  kind: 'time',
                  text: shortAgo(deployment.started_at ?? deployment.created_at),
                },
                ...(deployment.trigger?.source_sha
                  ? [
                      {
                        kind: 'version' as const,
                        text: deployment.trigger.source_sha.slice(0, 7),
                      },
                    ]
                  : []),
              ]}
              action={
                deployment.status === 'superseded' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rollback.isPending}
                    onClick={() => rollback.mutate(deployment.id)}
                  >
                    Roll back
                  </Button>
                ) : null
              }
            />
          ))}
        </ItemList>
      </Section>
      <Section title="Last log lines">
        <pre className="max-h-80 overflow-auto bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
          {(logs.data ?? [])
            .slice(-80)
            .map((line) => line.text)
            .join('\n') || 'No log lines yet.'}
        </pre>
      </Section>
    </Page>
  )
}
