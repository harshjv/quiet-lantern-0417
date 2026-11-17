import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { viewId, type Place } from '@/lib/nav'
import { appQuery, approvalQuery, deploymentQuery, machineQuery, tasksQuery } from '@/lib/queries'
import { pageTitle, placeTitle } from '@/lib/title'

import { pageOf } from './outside'

const modeTitle: Record<Place['mode'], string> = {
  build: 'Build',
  ship: 'Ship',
  observe: 'Observe',
  outside: 'Inbox',
}

const ifSet = (id: string | null) => ({
  enabled: Boolean(id),
})

function useViewName(place: Place) {
  const app = viewId(place.view, 'app')
  const deployment = viewId(place.view, 'deployment')
  const machine = viewId(place.view, 'machine')
  const approval = viewId(place.view, 'approval')
  const task = place.mode === 'build' && place.view && place.view !== 'new' ? place.view : null
  const apps = useQuery({
    ...appQuery(app ?? ''),
    ...ifSet(app),
  })
  const deployments = useQuery({
    ...deploymentQuery(deployment ?? ''),
    ...ifSet(deployment),
  })
  const machines = useQuery({
    ...machineQuery(machine ?? ''),
    ...ifSet(machine),
  })
  const approvals = useQuery({
    ...approvalQuery(approval ?? ''),
    ...ifSet(approval),
  })
  const tasks = useQuery({
    ...tasksQuery,
    ...ifSet(task),
  })

  if (app) {
    return apps.data?.name ?? ''
  }

  if (deployment) {
    return deployments.data ? `Deployment #${deployments.data.number}` : ''
  }

  if (machine) {
    return machines.data?.name ?? ''
  }

  if (approval) {
    return approvals.data?.title ?? ''
  }

  if (task) {
    return tasks.data?.items.find((t) => t.id === task)?.title ?? ''
  }

  return null
}

const projectPart = (place: Place) => {
  if (!place.project) {
    return ''
  }

  const preview = place.view?.startsWith('preview:') ? place.view.slice(8).split('/')[0]! : null

  return place.mode === 'ship' ? placeTitle(place.project, preview) : place.project
}

export function usePlaceTitle(place: Place) {
  const name = useViewName(place)
  const title =
    place.mode === 'outside'
      ? pageTitle(name ?? pageOf(place.view).title)
      : place.mode === 'build' && place.view === 'new'
        ? pageTitle('New task', projectPart(place))
        : pageTitle(name ?? '', projectPart(place), modeTitle[place.mode])

  useEffect(() => {
    document.title = title
  }, [title])
}
