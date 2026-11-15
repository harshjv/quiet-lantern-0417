export type Member = {
  name: string
  handle: string
  role: 'Admin' | 'Member'
  projects: string[]
  tasks: number
  active: string
}

export const members: Member[] = [
  {
    name: 'Harsh',
    handle: 'harshjv',
    role: 'Admin',
    projects: ['etherbit', 'yolo'],
    tasks: 14,
    active: 'now',
  },
  {
    name: 'Priya',
    handle: 'priya-s',
    role: 'Member',
    projects: ['etherbit'],
    tasks: 6,
    active: '2h ago',
  },
  {
    name: 'Sam',
    handle: 'samk',
    role: 'Member',
    projects: ['etherbit', 'yolo'],
    tasks: 3,
    active: 'yesterday',
  },
]

export const invites = [
  {
    code: 'K7QM-4TRX-9WPA',
    role: 'Member',
    project: 'etherbit',
    expires: 'in 6 days',
    by: 'Harsh',
  },
]

export type Level = 'check' | 'run' | 'approve'

export const levels: { id: Level; title: string; text: string; warn?: string }[] = [
  {
    id: 'check',
    title: 'Check on things',
    text: "What's running, what failed, what's waiting on you.",
  },
  {
    id: 'run',
    title: 'Run tasks',
    text: 'Also starts tasks and replies to them as you. Never approves.',
  },
  {
    id: 'approve',
    title: 'Run and approve',
    text: "Also approves the agent's commands for you.",
    warn: 'Only for an assistant you trust as much as yourself.',
  },
]

export const assistants = [
  {
    name: 'Claude on my laptop',
    level: 'run' as Level,
    used: '12m ago',
    last: 'start a task to fix the footer year',
  },
  {
    name: 'Slack #etherbit',
    level: 'check' as Level,
    used: 'yesterday',
  },
]

export const assistantKinds = ['Claude', 'ChatGPT', 'Slack', 'Other (MCP)']

export const servers = [
  {
    name: 'server-9bs4jr',
    where: 'Hetzner cx33 in Nuremberg',
    address: 'try.stationly.harshjv.com',
    usage: [
      {
        label: 'Memory',
        value: '5.1 of 7.6 GB',
        trend: [4, 5, 5, 6, 5, 6, 7, 6, 6, 7, 7, 7],
        max: 10,
      },
      {
        label: 'CPU',
        value: '22% of 4 cores',
        trend: [2, 3, 2, 4, 3, 2, 3, 5, 3, 2, 2, 2],
        max: 10,
      },
      {
        label: 'Disk',
        value: '41 of 75 GB',
        trend: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
        max: 10,
      },
    ],
  },
]

export type Placement = {
  what: string
  who: string
  kind: 'Project machine' | 'Own machine' | 'App' | 'Plain machine'
  memory: string
  state: string
  tone: 'success' | 'info' | 'neutral'
}

export const placements: Placement[] = [
  {
    what: 'etherbit',
    who: '3 tasks from Harsh, Priya and a private task',
    kind: 'Project machine',
    memory: '2.0 GB',
    state: '3 of 3 slots busy',
    tone: 'info',
  },
  {
    what: 'Big refactor',
    who: "Harsh's task, kept separate",
    kind: 'Own machine',
    memory: '1.0 GB',
    state: 'Paused, idle 40m',
    tone: 'neutral',
  },
  {
    what: 'api',
    who: 'etherbit production',
    kind: 'App',
    memory: '412 MB',
    state: 'Healthy',
    tone: 'success',
  },
  {
    what: 'postgres',
    who: 'etherbit production',
    kind: 'App',
    memory: '380 MB',
    state: 'Healthy',
    tone: 'success',
  },
  {
    what: 'scratch',
    who: 'Harsh, for trying things by hand',
    kind: 'Plain machine',
    memory: '256 MB',
    state: 'Stops in 2h',
    tone: 'info',
  },
]

export const release = {
  running: '0.1.3-rc.9',
  installed: '2h ago',
  available: '0.1.3-rc.10',
  changes: [
    'Every change to production is recorded with who made it',
    'Team keys no longer reach previews',
    'Stopping an idle task no longer records a stop',
  ],
}

export const health = [
  {
    label: 'Server agent',
    state: 'OK',
    text: 'rc.9 on 1 server',
  },
  {
    label: 'Certificates',
    state: 'OK',
    text: 'renew in 61 days',
  },
  {
    label: "Backups of Stationly's own data",
    state: 'Not set up',
    text: 'If this server is lost, projects and keys are lost with it.',
  },
]

export const teamKeys = [
  {
    key: 'POSTMARK_TOKEN',
    projects: ['etherbit', 'yolo'],
    previews: 'Production only',
    setBy: 'Harsh',
    age: '1 month ago',
  },
  {
    key: 'SENTRY_ORG_TOKEN',
    projects: ['etherbit'],
    previews: 'Same as production',
    setBy: 'Harsh',
    age: '2 weeks ago',
  },
]

export const tokens = [
  {
    name: 'GitHub Actions deploy',
    can: 'Deploy previews of etherbit',
    expires: 'in 82 days',
    used: '3h ago',
  },
  {
    name: 'Uptime checker',
    can: 'Read status',
    expires: 'never',
    used: '1m ago',
  },
]

export const places = [
  {
    name: 'Slack #etherbit',
    what: 'Failed deploys, changes shipped to production',
  },
  {
    name: 'Webhook ops.etherbit.in',
    what: 'Everything',
  },
]

export const emailWhen = [
  {
    text: 'An agent asks me something or needs an approval',
    on: true,
  },
  {
    text: 'Someone asks me to approve a change to production',
    on: true,
  },
  {
    text: 'A deploy I shipped fails',
    on: true,
  },
  {
    text: 'My task finishes',
    on: false,
  },
]

export const devices = [
  {
    name: 'Chrome on macOS',
    used: 'now',
    current: true,
  },
  {
    name: 'sly on harsh-mbp',
    used: '2h ago',
    current: false,
  },
]
