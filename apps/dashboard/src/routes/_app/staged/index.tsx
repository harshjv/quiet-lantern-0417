import { useQueries, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { stagedChangeStatusValues } from '@stationly/protocol/domain'

import { Empty, Mono, PageHeader } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
import { StagedStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ago } from '@/lib/format'
import { environmentQuery, stagedQuery } from '@/lib/queries'
import { toneText } from '@/lib/tone'

const statuses = stagedChangeStatusValues
type Status = (typeof statuses)[number]

export const Route = createFileRoute('/_app/staged/')({
  validateSearch: (search: Record<string, unknown>): { status?: Status } =>
    statuses.includes(search.status as Status)
      ? {
          status: search.status as Status,
        }
      : {},
  component: StagedPage,
})

function StagedPage() {
  const { status = 'staged' } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })
  const staged = useQuery(stagedQuery(status))
  const envIds = [
    ...new Set(
      (staged.data?.items ?? [])
        .map((c) => c.environment_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const environments = useQueries({
    queries: envIds.map((id) => environmentQuery(id)),
  })
  const names = new Map(
    environments.flatMap((e) => (e.data ? [[e.data.id, e.data.name] as const] : [])),
  )
  return (
    <div className="space-y-6">
      <PageHeader
        title="Staged changes"
        meta={
          <span>
            Changes to protected environments and the platform wait here until a human accepts or
            rejects them.
          </span>
        }
      />
      <Tabs
        value={status}
        onValueChange={(value) =>
          void navigate({
            search: {
              status: value as Status,
            },
            replace: true,
          })
        }
      >
        <TabsList>
          {statuses.map((s) => (
            <TabsTrigger key={s} value={s} className="capitalize">
              {s}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={status} className="mt-4">
          <QueryState
            query={staged}
            rows={4}
            isEmpty={noItems}
            empty={
              <Empty
                title={
                  status === 'staged' ? 'Nothing is waiting for review' : `No ${status} changes`
                }
              >
                Agents and tokens stage changes when they touch a protected environment.
              </Empty>
            }
          >
            {(data) => (
              <TableFrame>
                <TableHeader>
                  <TableRow>
                    <TableHead>Change</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Diff</TableHead>
                    <TableHead className="hidden md:table-cell">Requested by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((change) => (
                    <TableRow key={change.id} className="relative">
                      <TableCell>
                        <Link
                          to="/staged/$change"
                          params={{
                            change: change.id,
                          }}
                          className="font-medium after:absolute after:inset-0"
                        >
                          <Mono>{change.id}</Mono>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {change.environment_id
                          ? (names.get(change.environment_id) ?? (
                              <Mono className="text-muted-foreground">{change.environment_id}</Mono>
                            ))
                          : 'platform'}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className={toneText.success}>+{change.summary.add}</span>{' '}
                        <span className={toneText.warning}>~{change.summary.update}</span>{' '}
                        <span className={toneText.danger}>−{change.summary.remove}</span>
                        {change.summary.deployments > 0 && (
                          <span className="text-muted-foreground">
                            {' '}
                            · {change.summary.deployments} deploy
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {change.actor.type}
                        {change.actor.client && <span> · {change.actor.client}</span>} ·{' '}
                        {change.source}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {ago(change.created_at)}
                      </TableCell>
                      <TableCell>
                        <StagedStatusBadge status={change.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableFrame>
            )}
          </QueryState>
        </TabsContent>
      </Tabs>
    </div>
  )
}
