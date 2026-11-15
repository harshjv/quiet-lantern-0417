import type { Fact } from './parts'

export const order = [
  'command',
  'finished',
  'review',
  'deploying',
  'failed',
  'fixing',
  'fixed',
  'fixReview',
  'fixDeploying',
  'healthy',
] as const

export type Stage = (typeof order)[number]

export const after = (stage: Stage, from: Stage) => order.indexOf(stage) >= order.indexOf(from)

export type Phase = 'working' | 'ready' | 'review' | 'deploying' | 'failed' | 'shipped'

export type Change = {
  task: string
  title: string
  branch: string
  version: string
  previous: string
  summary: string
  files: [string, string][]
  fileCount: number
  delta: string
  checks: { label: string; time: string }[]
  firstStep: string
  preview: string
  stages: { ready: Stage; review: Stage; deploying: Stage; end: Stage }
  fails: boolean
}

export const changes: Record<'paise' | 'fix', Change> = {
  paise: {
    task: 'paise',
    title: 'Move order totals to integer paise',
    branch: 'task/paise @ 4f2e1a9',
    version: 'v42',
    previous: 'v41',
    summary:
      'Every amount is stored and computed as integer paise. Migration 0042 converts existing orders. Tests pass, and the preview database was converted with every total matching to the paisa.',
    files: [
      ['src/orders/totals.ts', '+88 −41'],
      ['src/orders/invoice.ts', '+52 −30'],
      ['migrations/0042_integer_paise.sql', '+64'],
      ['test/orders/totals.test.ts', '+71 −9'],
    ],
    fileCount: 9,
    delta: '+310 −96',
    checks: [
      {
        label: 'Tests passed in the task',
        time: '212',
      },
      {
        label: 'Preview is healthy',
        time: '3 apps',
      },
    ],
    firstStep: 'Runs migration 0042 in production first',
    preview: 'integer-paise.etherbit.preview',
    stages: {
      ready: 'finished',
      review: 'review',
      deploying: 'deploying',
      end: 'failed',
    },
    fails: true,
  },
  fix: {
    task: 'fixv42',
    title: 'Fix the failed api v42 deploy',
    branch: 'task/fixv42 @ 9c1d07b',
    version: 'v43',
    previous: 'v41',
    summary:
      'The start script now runs pending migrations before the server starts, and refuses to start if one fails. Checked against a fresh copy of the preview database: migration 0042 runs, then the health check answers in 40 ms.',
    files: [
      ['scripts/start.sh', '+9 −1'],
      ['Dockerfile', '+2 −1'],
      ['test/deploy/start.test.ts', '+34'],
    ],
    fileCount: 3,
    delta: '+45 −2',
    checks: [
      {
        label: 'Tests passed in the task',
        time: '215',
      },
      {
        label: 'Preview started from an empty database',
        time: '40 ms',
      },
    ],
    firstStep: 'Includes the integer paise change from v42',
    preview: 'fixv42.etherbit.preview',
    stages: {
      ready: 'fixed',
      review: 'fixReview',
      deploying: 'fixDeploying',
      end: 'healthy',
    },
    fails: false,
  },
}

export const activeChange = (stage: Stage) => changes[after(stage, 'fixing') ? 'fix' : 'paise']

export function phaseOf(change: Change, stage: Stage): Phase {
  const { ready, review, deploying, end } = change.stages

  if (stage === ready) {
    return 'ready'
  }

  if (stage === review) {
    return 'review'
  }

  if (stage === deploying) {
    return 'deploying'
  }

  if (after(stage, end)) {
    return change.fails && stage !== 'healthy' ? 'failed' : 'shipped'
  }

  return 'working'
}

export const phaseFacts = (change: Change, phase: Phase): Fact[] =>
  phase === 'ready'
    ? [
        {
          kind: 'files',
          text: `${change.fileCount} files`,
        },
        {
          kind: 'preview',
          text: change.preview,
        },
      ]
    : phase === 'failed'
      ? [
          {
            kind: 'version',
            text: `${change.version} failed`,
          },
          {
            kind: 'version',
            text: `${change.previous} still serving`,
          },
        ]
      : [
          {
            kind: 'app',
            text: 'api',
          },
          {
            kind: 'version',
            text: phase === 'shipped' && change.fails ? 'v43, with the fix' : change.version,
          },
        ]
