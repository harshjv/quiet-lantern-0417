import { runTerminalStatuses } from '@stationly/protocol'

import { exitCodes } from '../errors.ts'
import type { Api, Data } from '../kit.ts'
import { human } from '../output.ts'

type Waited = Data<ReturnType<Api['deployments']>['wait']['get']>

type RunRow = Data<ReturnType<Api['runs']>['get']>

const ended = new Set(['failed', 'cancelled'])

export const deploymentText = (deployment: Waited) =>
  deployment.status === 'failed'
    ? `${human(deployment)}\n\ndiagnosis: sly deployments get-diagnosis ${deployment.id}`
    : human(deployment)

export const deploymentExit = (deployment: Waited) =>
  ended.has(deployment.status) ? exitCodes.deployFailed : exitCodes.ok

const terminal = new Set<string>(runTerminalStatuses)

export const runEnded = (status: string) => terminal.has(status)

export const runExit = (run: RunRow) =>
  runEnded(run.status) && run.status !== 'succeeded' ? exitCodes.api : exitCodes.ok
