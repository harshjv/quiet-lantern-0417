import type { Tone } from '@/lib/tone'

export type Project = { id: string; name: string; repos: string[] }

export const projects: Project[] = [
  {
    id: 'etherbit',
    name: 'etherbit',
    repos: ['harshjv/etherbit-next-api', 'harshjv/etherbit-next-ui', 'harshjv/etherbit-payments'],
  },
  {
    id: 'yolo',
    name: 'yolo',
    repos: ['harshjv/etherbit-next-ui'],
  },
]

export const unreachableRepos = ['harshjv/etherbit-payments']

export const yourKeys = {
  claude: true,
  codex: false,
}

export const teammates = [
  {
    name: 'Priya',
    handle: 'priya-s',
  },
  {
    name: 'Arjun',
    handle: 'arjunm',
  },
]

export type TaskState = 'working' | 'waiting' | 'finished' | 'queued' | 'failed' | 'setup'

export type Task = {
  id: string
  title: string
  project: string
  state: TaskState
  reason: string
  age: string
  owner: string
  forkOf?: string
}

export const tasks: Task[] = [
  {
    id: 'signup',
    title: 'Fix the signup email link',
    project: 'yolo',
    state: 'waiting',
    reason: 'Asked a question',
    age: '4m',
    owner: 'you',
  },
  {
    id: 'paise',
    title: 'Move order totals to integer paise',
    project: 'etherbit',
    state: 'waiting',
    reason: 'Approve a command',
    age: '6m',
    owner: 'you',
  },
  {
    id: 'dark',
    title: 'Add dark mode to the storefront',
    project: 'yolo',
    state: 'finished',
    reason: 'Ready to ship',
    age: '18m',
    owner: 'you',
  },
  {
    id: 'flow',
    title: "Summarise the API's business flow",
    project: 'etherbit',
    state: 'working',
    reason: 'Sonnet 5.5',
    age: '2m',
    owner: 'you',
  },
  {
    id: 'next16',
    title: 'Upgrade Next.js to 16',
    project: 'yolo',
    state: 'queued',
    reason: 'Starts when a task finishes',
    age: '1m',
    owner: 'you',
  },
  {
    id: 'gst',
    title: 'Write the GST invoice export',
    project: 'etherbit',
    state: 'finished',
    reason: 'Shared by Priya',
    age: '3h',
    owner: 'Priya',
  },
]

export const taskTone: Record<TaskState, Tone> = {
  working: 'info',
  setup: 'info',
  waiting: 'warning',
  finished: 'success',
  queued: 'neutral',
  failed: 'danger',
}

export type App = {
  name: string
  project: string
  kind: string
  state: 'live' | 'failed' | 'stopped' | 'deploying'
  link: string | null
  stats: { value: string; label: string }[]
  trend: number[]
}

export const apps: App[] = [
  {
    name: 'web',
    project: 'etherbit',
    kind: 'Website',
    state: 'live',
    link: 'etherbit.in',
    stats: [
      {
        value: '1.2k',
        label: 'req/h',
      },
      {
        value: '2h',
        label: 'deployed',
      },
      {
        value: 'v18',
        label: 'version',
      },
    ],
    trend: [4, 5, 3, 6, 7, 5, 8, 6, 7, 9, 7, 6],
  },
  {
    name: 'api',
    project: 'etherbit',
    kind: 'API',
    state: 'failed',
    link: 'api.etherbit.in',
    stats: [
      {
        value: '840',
        label: 'req/h',
      },
      {
        value: 'v41',
        label: 'serving',
      },
      {
        value: 'v42',
        label: 'failed',
      },
    ],
    trend: [5, 4, 6, 5, 6, 5, 6, 7, 5, 6, 2, 6],
  },
  {
    name: 'worker',
    project: 'etherbit',
    kind: 'Background jobs',
    state: 'live',
    link: null,
    stats: [
      {
        value: '14',
        label: 'jobs/min',
      },
      {
        value: '0',
        label: 'failed',
      },
      {
        value: '3',
        label: 'queued',
      },
    ],
    trend: [2, 3, 3, 2, 4, 3, 2, 3, 3, 2, 3, 2],
  },
  {
    name: 'postgres',
    project: 'etherbit',
    kind: 'Database',
    state: 'live',
    link: null,
    stats: [
      {
        value: '2.1',
        label: 'GB used',
      },
      {
        value: '10',
        label: 'GB max',
      },
      {
        value: '3h',
        label: 'backup',
      },
    ],
    trend: [6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7],
  },
  {
    name: 'storefront',
    project: 'yolo',
    kind: 'Website',
    state: 'live',
    link: 'yolo.example.com',
    stats: [
      {
        value: '310',
        label: 'req/h',
      },
      {
        value: '1d',
        label: 'deployed',
      },
      {
        value: 'v7',
        label: 'version',
      },
    ],
    trend: [3, 2, 4, 3, 3, 5, 4, 3, 4, 5, 4, 4],
  },
]

export const previews = [
  {
    name: 'integer-paise',
    project: 'etherbit',
    from: 'Task by Harsh',
    branch: 'task/integer-paise',
    state: 'live' as const,
    expires: 'in 6 days',
  },
  {
    name: 'pr-118',
    project: 'etherbit',
    from: 'Pull request #118',
    branch: 'cod-checkout',
    state: 'missing-key' as const,
    expires: 'when the pull request closes',
  },
  {
    name: 'staging',
    project: 'etherbit',
    from: 'Kept by an admin',
    branch: 'main',
    state: 'live' as const,
    expires: 'never',
  },
  {
    name: 'dark-mode',
    project: 'yolo',
    from: 'Task by Harsh',
    branch: 'task/dark-mode',
    state: 'live' as const,
    expires: 'in 7 days',
  },
]

export const approvals = [
  {
    kind: 'ship' as const,
    title: 'Ship "Add dark mode to the storefront" to production',
    project: 'yolo',
    by: 'Harsh',
    age: '20m',
    facts: [
      {
        kind: 'files' as const,
        text: '4 files',
      },
      {
        kind: 'tests' as const,
        text: 'passed',
      },
      {
        kind: 'preview' as const,
        text: 'healthy',
      },
    ],
  },
  {
    kind: 'key' as const,
    title: 'Set RAZORPAY_KEY_SECRET in production',
    project: 'etherbit',
    by: 'Priya',
    age: 'yesterday',
    facts: [
      {
        kind: 'app' as const,
        text: 'redeploys api',
      },
    ],
  },
]

export const incidents = [
  {
    title: 'api v42 failed to deploy',
    project: 'etherbit',
    tone: 'danger' as Tone,
    facts: [
      {
        kind: 'health' as const,
        text: 'never passed',
      },
      {
        kind: 'version' as const,
        text: 'v41 still serving',
      },
    ],
    age: '6m',
  },
  {
    title: 'Slow query on orders_by_customer',
    project: 'etherbit',
    tone: 'warning' as Tone,
    facts: [
      {
        kind: 'health' as const,
        text: 'p95 1.8 s, was 210 ms',
      },
      {
        kind: 'version' as const,
        text: 'since v41',
      },
    ],
    age: '1h',
  },
]

export type DeployRow = {
  version: string
  state: 'live' | 'failed' | 'replaced'
  branch: string
  by: string
  approvedBy: string | null
  age: string
}

export const deploysOf: Record<string, DeployRow[]> = {
  web: [
    {
      version: 'v18',
      state: 'live',
      branch: 'main @ 91be004',
      by: 'Harsh',
      approvedBy: 'Priya',
      age: '2h',
    },
    {
      version: 'v17',
      state: 'replaced',
      branch: 'main @ 3c08a1e',
      by: 'Priya',
      approvedBy: 'Harsh',
      age: '3d',
    },
    {
      version: 'v16',
      state: 'replaced',
      branch: 'main @ e7a0935',
      by: 'Harsh',
      approvedBy: null,
      age: '5d',
    },
  ],
  api: [
    {
      version: 'v41',
      state: 'live',
      branch: 'main @ 91be004',
      by: 'Priya',
      approvedBy: 'Harsh',
      age: '1d',
    },
    {
      version: 'v40',
      state: 'replaced',
      branch: 'main @ 3c08a1e',
      by: 'Harsh',
      approvedBy: 'Priya',
      age: '3d',
    },
    {
      version: 'v39',
      state: 'replaced',
      branch: 'main @ e7a0935',
      by: 'Harsh',
      approvedBy: null,
      age: '5d',
    },
  ],
}

export type KeyRow = {
  key: string
  secret: boolean
  production: 'set' | 'linked' | 'missing'
  previews: 'own' | 'same' | 'missing' | 'linked' | 'none'
  previewValue?: string
  productionValue?: string
  usedBy: string[]
  setBy: string
  age: string
}

export const keysOf: Record<string, KeyRow[]> = {
  etherbit: [
    {
      key: 'DATABASE_URL',
      secret: false,
      production: 'linked',
      previews: 'linked',
      usedBy: ['api', 'worker'],
      setBy: 'Harsh',
      age: '3 days ago',
    },
    {
      key: 'RAZORPAY_KEY_SECRET',
      secret: true,
      production: 'set',
      previews: 'missing',
      usedBy: ['api'],
      setBy: 'Priya',
      age: 'yesterday',
    },
    {
      key: 'RAZORPAY_KEY_ID',
      secret: false,
      production: 'set',
      productionValue: 'rzp_live_••••3f',
      previews: 'own',
      previewValue: 'rzp_test_••••a1',
      usedBy: ['api', 'web'],
      setBy: 'Priya',
      age: 'yesterday',
    },
    {
      key: 'SENTRY_DSN',
      secret: true,
      production: 'set',
      previews: 'same',
      usedBy: ['api', 'web', 'worker'],
      setBy: 'Harsh',
      age: '2 weeks ago',
    },
    {
      key: 'SMTP_PASSWORD',
      secret: true,
      production: 'missing',
      previews: 'none',
      usedBy: [],
      setBy: 'Harsh',
      age: 'today',
    },
  ],
  yolo: [
    {
      key: 'NEXT_PUBLIC_SITE_URL',
      secret: false,
      production: 'set',
      productionValue: 'https://yolo.example.com',
      previews: 'own',
      previewValue: 'per preview',
      usedBy: ['storefront'],
      setBy: 'Harsh',
      age: 'last week',
    },
  ],
}

export const sharedApps = [
  {
    name: 'postgres-main',
    kind: 'Postgres 17',
    usedBy: ['yolo'],
    size: '2.1 GB',
  },
  {
    name: 'redis-cache',
    kind: 'Redis 8',
    usedBy: [],
    size: '40 MB',
  },
]

export type LogLine = {
  at: string
  app: string
  v: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export const logs: LogLine[] = [
  {
    at: '12:31:02',
    app: 'web',
    v: 'v18',
    level: 'info',
    text: 'GET / 200 18ms',
  },
  {
    at: '12:31:04',
    app: 'api',
    v: 'v41',
    level: 'info',
    text: 'GET /orders/8812 200 34ms',
  },
  {
    at: '12:31:05',
    app: 'api',
    v: 'v41',
    level: 'info',
    text: 'POST /checkout 201 212ms',
  },
  {
    at: '12:31:06',
    app: 'worker',
    v: 'v9',
    level: 'info',
    text: 'job invoice.render done in 1.1s',
  },
  {
    at: '12:31:09',
    app: 'api',
    v: 'v41',
    level: 'warn',
    text: 'slow query orders_by_customer 1.8s',
  },
  {
    at: '12:31:11',
    app: 'api',
    v: 'v41',
    level: 'info',
    text: 'GET /health 200 2ms',
  },
  {
    at: '12:31:12',
    app: 'web',
    v: 'v18',
    level: 'info',
    text: 'GET /products/blue-kurta 200 41ms',
  },
  {
    at: '12:31:14',
    app: 'api',
    v: 'v41',
    level: 'error',
    text: 'razorpay webhook signature mismatch (order 8813)',
  },
  {
    at: '12:31:15',
    app: 'worker',
    v: 'v9',
    level: 'info',
    text: 'job email.receipt done in 0.3s',
  },
  {
    at: '12:31:20',
    app: 'api',
    v: 'v41',
    level: 'info',
    text: 'POST /cart 200 18ms',
  },
  {
    at: '12:31:22',
    app: 'storefront',
    v: 'v7',
    level: 'info',
    text: 'GET / 200 22ms',
  },
]

export const metricsOf: Record<
  string,
  { label: string; value: string; trend: number[]; tone?: Tone; max?: number }[]
> = {
  web: [
    {
      label: 'requests per hour',
      value: '1.2k',
      trend: [4, 5, 3, 6, 7, 5, 8, 6, 7, 9, 7, 6, 8, 9, 7, 8],
    },
    {
      label: 'errors',
      value: '0.1%',
      trend: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      max: 10,
    },
    {
      label: 'response time p95',
      value: '180 ms',
      trend: [5, 5, 6, 5, 5, 6, 5, 5, 6, 5, 5, 5, 6, 5, 5, 5],
    },
    {
      label: 'memory of 1 GB',
      value: '310 MB',
      trend: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
      max: 10,
    },
  ],
  api: [
    {
      label: 'requests per hour',
      value: '840',
      trend: [5, 4, 6, 5, 6, 5, 6, 7, 5, 6, 6, 6, 5, 6, 7, 6],
    },
    {
      label: 'errors',
      value: '0.2%',
      trend: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 6, 1, 1, 1, 1, 1],
      max: 10,
      tone: 'danger',
    },
    {
      label: 'response time p95',
      value: '212 ms',
      trend: [4, 4, 5, 4, 4, 5, 4, 8, 4, 5, 4, 4, 5, 4, 4, 4],
      tone: 'warning',
    },
    {
      label: 'memory of 1 GB',
      value: '412 MB',
      trend: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      max: 10,
    },
  ],
}

export type ActivityRow = {
  kind: 'deploy' | 'stop' | 'key' | 'invite' | 'assistant' | 'approve'
  title: string
  project: string
  who: string
  via: 'dashboard' | 'task' | 'assistant'
  age: string
  failed?: boolean
}

export const activity: ActivityRow[] = [
  {
    kind: 'deploy',
    title: 'api v42 deployed to production',
    project: 'etherbit',
    who: 'Harsh',
    via: 'dashboard',
    age: '6m',
    failed: true,
  },
  {
    kind: 'approve',
    title: 'Approved "Move order totals to integer paise"',
    project: 'etherbit',
    who: 'Harsh',
    via: 'dashboard',
    age: '7m',
  },
  {
    kind: 'stop',
    title: 'web stopped in production',
    project: 'yolo',
    who: 'Clean up old cron jobs, a task by Harsh',
    via: 'task',
    age: '40m',
  },
  {
    kind: 'key',
    title: 'RAZORPAY_KEY_SECRET changed in production',
    project: 'etherbit',
    who: 'Priya',
    via: 'dashboard',
    age: '2h',
  },
  {
    kind: 'invite',
    title: 'Sam invited to etherbit',
    project: 'etherbit',
    who: 'Harsh',
    via: 'dashboard',
    age: '5h',
  },
  {
    kind: 'assistant',
    title: 'Claude connected at Run tasks',
    project: 'etherbit',
    who: 'Harsh',
    via: 'assistant',
    age: 'yesterday',
  },
]

export const baseTask = (id: string) => tasks.find((t) => t.id === id)
