import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, type LinkOptions } from '@tanstack/react-router'
import { Rocket } from 'lucide-react'
import type { ReactNode } from 'react'

import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import { ApprovalStatusBadge, DeploymentStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { approvalHeadline } from '@/lib/changes'
import { productionOf } from '@/lib/place'
import {
  appsQuery,
  placeDeploymentsQuery,
  projectApprovalsQuery,
  projectQuery,
} from '@/lib/queries'

import { useNames, usePlaces } from './names'
import { Page, PageBoundary } from './parts'

type Entry = {
  id: string
  kind: string
  what: string
  status: ReactNode
  at: string
  to: LinkOptions
}

export function ProjectShipLog({ project }: { project: string }) {
  return (
    <PageBoundary title="Couldn’t load this project" resetKey={project}>
      <Page title="Ship">
        <Panel rows={4} title="Couldn’t load deployments and approvals">
          <ShipLog project={project} />
        </Panel>
      </Page>
    </PageBoundary>
  )
}

function ShipLog({ project: projectRef }: { project: string }) {
  const { data: project } = useSuspenseQuery(projectQuery(projectRef))
  const production = productionOf(project.id)
  const { data: deployments } = useSuspenseQuery(placeDeploymentsQuery(production, 50))
  const { data: apps } = useSuspenseQuery(appsQuery(production))
  const { data: approvals } = useSuspenseQuery(projectApprovalsQuery(project.id))
  const names = useNames([project.id])
  const places = usePlaces([project.id])
  const appName = new Map(apps.items.map((app) => [app.id, app.name]))
  const entries: Entry[] = [
    ...deployments.items.map((deployment): Entry => ({
      id: deployment.id,
      kind: 'Deployment',
      what: `${appName.get(deployment.app_id) ?? deployment.app_id} #${deployment.number}`,
      status: <DeploymentStatusBadge status={deployment.status} />,
      at: deployment.created_at ?? '',
      to: {
        to: '/deployments/$deployment',
        params: {
          deployment: deployment.id,
        },
      },
    })),
    ...approvals.items.map((approval): Entry => ({
      id: approval.id,
      kind: 'Approval',
      what: approvalHeadline(approval, names, places),
      status: <ApprovalStatusBadge status={approval.status} />,
      at: approval.created_at,
      to: {
        to: '/approvals/$approval',
        params: {
          approval: approval.id,
        },
      },
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  if (entries.length === 0) {
    return <EmptyState icon={Rocket} title="No deployments or approvals yet" />
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>What</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id} className="relative">
            <TableCell className="max-w-96 truncate">
              <Link
                {...entry.to}
                className="font-medium after:absolute after:inset-0 focus-visible:outline-none"
              >
                {entry.what}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{entry.kind}</TableCell>
            <TableCell>{entry.status}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              <Time value={entry.at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}
