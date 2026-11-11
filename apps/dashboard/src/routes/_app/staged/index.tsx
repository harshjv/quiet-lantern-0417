import { useQueries, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { stagedChangeStatusValues } from '@stationly/protocol/domain'

import { Actor, AgentsLink } from '@/components/actor'
import { EmptyState, PageHeader } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { StagedStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { changeSummary } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { stagedSource, stagedStatus } from '@/lib/labels'
import { environmentQuery, load, stagedQuery } from '@/lib/queries'
import { titled } from '@/lib/title'
import { z } from '@/lib/zod'

const statuses = stagedChangeStatusValues

type Status = (typeof statuses)[number]

export const Route = createFileRoute('/_app/staged/')({
  validateSearch: z.object({
    status: z.enum(statuses).default('staged').catch('staged'),
  }),
  loader: ({ context }) => load(context.queryClient, stagedQuery('staged')),
  head: () => titled('Staged changes'),
  errorComponent: failurePage('Couldn’t load staged changes'),
  component: StagedPage,
})

function StagedTable({ status }: { status: Status }) {
  const { data } = useSuspenseQuery(stagedQuery(status))
  const envIds = [
    ...new Set(data.items.map((c) => c.environment_id).filter((id): id is string => Boolean(id))),
  ]
  const environments = useQueries({
    queries: envIds.map((id) => environmentQuery(id)),
  })
  const names = new Map(
    environments.flatMap((e) => (e.data ? [[e.data.id, e.data.name] as const] : [])),
  )

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.stagedChange}
        title={
          status === 'staged'
            ? 'Nothing to review'
            : `No ${stagedStatus[status].label.toLowerCase()} changes`
        }
        description={
          <>
            Changes from <AgentsLink /> and tokens to a{' '}
            <Term name="protectedEnvironment">protected environment</Term> wait here for you.
          </>
        }
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>Change</TableHead>
          <TableHead>Environment</TableHead>
          <TableHead>Changes</TableHead>
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
                <span className="font-mono text-[0.8125rem]">{change.id}</span>
              </Link>
            </TableCell>
            <TableCell>
              {change.environment_id
                ? (names.get(change.environment_id) ?? (
                    <span className="font-mono text-[0.8125rem] text-muted-foreground">
                      {change.environment_id}
                    </span>
                  ))
                : 'Platform'}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {changeSummary(change.summary)}
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">
              <Actor actor={change.actor} /> through {stagedSource[change.source]}
            </TableCell>
            <TableCell className="text-muted-foreground">
              <Time value={change.created_at} />
            </TableCell>
            <TableCell>
              <StagedStatusBadge status={change.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function StagedPage() {
  const { status } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staged changes"
        meta={
          <span>
            Changes to protected environments and the platform wait here until you accept or reject
            them.
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
            <TabsTrigger key={s} value={s}>
              {stagedStatus[s].label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={status} className="mt-4">
          <Panel rows={4} title="Couldn’t load staged changes">
            <StagedTable status={status} />
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}
