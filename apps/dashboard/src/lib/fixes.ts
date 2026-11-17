import type { ErrorCode, RemedyCode } from '@stationly/protocol'
import { bytesText } from '@stationly/protocol/format'

import type { NetworkMap } from './api.ts'
import { commands, scopeLabel, type AppScope, type Scope } from './commands.ts'

export type Fix = {
  code: string
  text: string
  action?: {
    tool: string
    input: Record<string, unknown>
  }
}

export type Subject = {
  kind: 'app' | 'machine'
  id: string
  name: string
}

export type FixContext = Scope & {
  subject: Subject
  names?: Record<string, string>
  deployment?: {
    id: string
    build: string | null
  }
  server?: string
}

export type Run = {
  name: string
} & (
  | {
      tool: 'deploy'
      app: string
    }
  | {
      tool: 'start_app'
      app: string
    }
  | {
      tool: 'rollback'
      app: string
      deployment: string
    }
  | {
      tool: 'update_app'
      app: string
      body: Record<string, unknown>
    }
  | {
      tool: 'start_machine'
      machine: string
    }
)

export type FixPlan = {
  code: string
  text: string
  button: {
    label: string
    run: Run
  } | null
  command: string | null
  prompt: string
  tool: string | null
}

type Target = Subject & {
  scope: AppScope
}

type Input = {
  fix: Fix
  input: Record<string, unknown>
  target: Target
  context: FixContext
}

type Remedy = {
  ask: (i: Input) => string
  button?: (i: Input) => FixPlan['button']
  command?: (i: Input) => string | null
}

const text = (value: unknown) => (typeof value === 'string' ? value : null)

const count = (value: unknown) => (typeof value === 'number' ? value : null)

const memoryOf = (input: Record<string, unknown>) => {
  const limits = input.limits

  return limits && typeof limits === 'object' && 'memory_bytes' in limits
    ? count(limits.memory_bytes)
    : null
}

const deployTarget: Remedy = {
  ask: ({ target }) => `deploy ${target.name} and wait until it’s active`,
  button: ({ target }) => ({
    label: `Deploy ${target.name}`,
    run: {
      tool: 'deploy',
      name: target.name,
      app: target.id,
    },
  }),
  command: ({ target }) => commands.deploy(target.scope),
}

const startApp: Remedy = {
  ask: ({ target }) => `start ${target.name} and check that it becomes healthy`,
  button: ({ target }) => ({
    label: `Start ${target.name}`,
    run: {
      tool: 'start_app',
      name: target.name,
      app: target.id,
    },
  }),
  command: ({ target }) => commands.startApp(target.scope),
}

const startMachine: Remedy = {
  ask: ({ target }) => `start the machine ${target.name}`,
  button: ({ target }) => ({
    label: `Start ${target.name}`,
    run: {
      tool: 'start_machine',
      name: target.name,
      machine: target.id,
    },
  }),
  command: ({ target, context }) => commands.startMachine(context, target.name),
}

const starter = ({ target }: Input) => (target.kind === 'machine' ? startMachine : startApp)

const logsCommand = ({ target, context }: Input) =>
  context.deployment
    ? commands.logs(target.scope, context.deployment.id, context.deployment.build)
    : null

export const remedies: Record<RemedyCode, Remedy> = {
  RAISE_MEMORY: {
    ask: ({ target, input }) => {
      const memory = memoryOf(input)

      return memory
        ? `raise ${target.name}’s memory limit to ${bytesText(memory)} and redeploy it`
        : `raise ${target.name}’s memory limit and redeploy it`
    },
    button: ({ target, input }) => {
      const memory = memoryOf(input)

      return memory
        ? {
            label: `Raise memory to ${bytesText(memory)} and redeploy`,
            run: {
              tool: 'update_app',
              name: target.name,
              app: target.id,
              body: {
                limits: input.limits,
              },
            },
          }
        : null
    },
    command: ({ target, input }) => {
      const memory = memoryOf(input)

      return memory ? commands.setMemory(target.scope, memory) : null
    },
  },
  RAISE_STARTUP_TIMEOUT: {
    ask: ({ target }) =>
      `raise ${target.name}’s health check startup timeout so it has time to start, then redeploy it`,
  },
  CHECK_HEALTH_PATH: {
    ask: ({ target }) => `find out why ${target.name} fails its health check, fix it and redeploy`,
    command: logsCommand,
  },
  READ_LOGS: {
    ask: ({ target }) =>
      `read the logs of ${target.name}’s failed deployment, find the cause and fix it`,
    command: logsCommand,
  },
  READ_BUILD_LOGS: {
    ask: ({ target }) =>
      `read the build log of ${target.name}’s failed deployment, fix the Dockerfile or source and deploy again`,
    command: logsCommand,
  },
  ROLLBACK: {
    ask: ({ target, input }) =>
      `roll ${target.name} back to deployment ${text(input.deployment_id) ?? 'the last good one'}`,
    button: ({ target, input }) => {
      const deployment = text(input.deployment_id)

      return deployment
        ? {
            label: 'Roll back to the last good deployment',
            run: {
              tool: 'rollback',
              name: target.name,
              app: target.id,
              deployment,
            },
          }
        : null
    },
    command: ({ target, input }) => {
      const deployment = text(input.deployment_id)

      return deployment ? commands.rollback(target.scope, deployment) : null
    },
  },
  RESOLVE_IMAGE: {
    ask: ({ target }) =>
      `set ${target.name}’s image source again so Stationly pins it to a digest, then deploy it`,
  },
  FIX_CONFIGURATION: {
    ask: ({ target }) =>
      `read the diagnosis of ${target.name}’s failed deployment, correct the setting it names and deploy again`,
  },
  DEPLOY_TARGET: deployTarget,
  START_TARGET: {
    ask: (i) => starter(i).ask(i),
    button: (i) => starter(i).button!(i),
    command: (i) => starter(i).command!(i),
  },
  BIND_ALL_INTERFACES: {
    ask: ({ target }) =>
      `make ${target.name} listen on 0.0.0.0 instead of localhost and redeploy it`,
  },
  USE_DECLARED_PORT: {
    ask: ({ target }) =>
      `make ${target.name} listen on the port it declares, or declare the port it listens on, and redeploy it`,
  },
  DECLARE_PORT: {
    ask: ({ target }) => `declare the port ${target.name} listens on as one of its ports`,
  },
  USE_INTERNAL_NAME: {
    ask: ({ context }) => `make ${context.subject.name} reach the other app by its .internal name`,
  },
  ATTACH_SHARED: {
    ask: ({ context }) => `attach the shared app ${context.subject.name} needs`,
  },
  EXPOSE_TCP: {
    ask: ({ target, input }) =>
      `expose ${target.name}’s TCP port${count(input.port) === null ? '' : ` ${count(input.port)}`} on the server`,
    command: ({ input }) => commands.exposeTcp(text(input.port_id)),
  },
  ADD_DOMAIN: {
    ask: ({ target }) => `add a direct domain to ${target.name}`,
    command: ({ input }) => commands.addDomain(text(input.port_id)),
  },
  WAIT_FOR_APPLY: {
    ask: ({ target }) =>
      `find out why the server hasn’t applied ${target.name}’s latest settings and fix what blocks it`,
  },
  CHECK_DNS_RECORD: {
    ask: ({ target }) =>
      `check the DNS records of ${target.name}’s domains and point them at the server’s public address`,
  },
  SET_PUBLIC_ADDRESS: {
    ask: () => 'set the server’s public address',
    command: ({ context }) => (context.server ? commands.setPublicAddress(context.server) : null),
  },
  RUN_PROBE: {
    ask: ({ context, input }) =>
      `send a test connection from ${context.subject.name} to ${text(input.to) ?? 'the target'} and tell me whether it answers`,
    command: ({ context, input }) => {
      const to = text(input.to)

      return to && context.subject.kind === 'app'
        ? commands.probe(
            {
              ...context,
              app: context.subject.name,
            },
            to,
            count(input.port),
          )
        : null
    },
  },
  ALLOW_DOMAIN: {
    ask: ({ context }) =>
      `add the destination to the machine ${context.subject.name}’s outbound allowlist`,
  },
  JOIN_ENVIRONMENT: {
    ask: ({ context }) =>
      `move the machine ${context.subject.name} onto its network so it can reach apps`,
  },
}

const isRemedy = (code: string): code is RemedyCode => Object.hasOwn(remedies, code)

const targetOf = (fix: Fix, context: FixContext): Target => {
  const input = fix.action?.input ?? {}
  const machine = text(input.machine)
  const id = text(input.app) ?? machine ?? context.subject.id
  const name =
    id === context.subject.id ? context.subject.name : (context.names?.[id] ?? context.subject.name)

  return {
    kind: machine ? 'machine' : id === context.subject.id ? context.subject.kind : 'app',
    id,
    name,
    scope: {
      project: context.project,
      preview: context.preview,
      app: name,
    },
  }
}

const prompt = (ask: string, context: FixContext) =>
  `In ${scopeLabel(context)} on Stationly, ${ask}${/[.!?]$/.test(ask) ? '' : '.'}`

export const planFix = (fix: Fix, context: FixContext): FixPlan => {
  const target = targetOf(fix, context)
  const tool = fix.action?.tool ?? null

  if (!isRemedy(fix.code)) {
    return {
      code: fix.code,
      text: fix.text,
      button: null,
      command: null,
      prompt: prompt(`help me with this: ${fix.text}`, context),
      tool,
    }
  }

  const remedy = remedies[fix.code]
  const input: Input = {
    fix,
    input: fix.action?.input ?? {},
    target,
    context,
  }

  return {
    code: fix.code,
    text: fix.text,
    button: remedy.button?.(input) ?? null,
    command: remedy.command?.(input) ?? null,
    prompt: prompt(remedy.ask(input), context),
    tool,
  }
}

type Finding = NetworkMap['warnings'][number]
type FindingCode = Finding['code']
type MapApp = NetworkMap['apps'][number]

export const findingRemedy: Record<FindingCode, RemedyCode | null> = {
  SWITCH_NO_TARGET: 'DEPLOY_TARGET',
  SWITCH_PENDING: 'WAIT_FOR_APPLY',
  SWITCH_MISMATCH: 'WAIT_FOR_APPLY',
  NAME_NOT_IN_NETWORK: 'USE_INTERNAL_NAME',
  PATH_BLOCKED: null,
  DOMAIN_NOT_ALLOWED: 'ALLOW_DOMAIN',
  TARGET_NOT_RUNNING: 'DEPLOY_TARGET',
  TARGET_UNHEALTHY: 'CHECK_HEALTH_PATH',
  NOT_LISTENING: 'USE_DECLARED_PORT',
  LISTENING_LOOPBACK_ONLY: 'BIND_ALL_INTERFACES',
  PORT_NOT_DECLARED: 'DECLARE_PORT',
  DOMAIN_NOT_ACTIVE: 'CHECK_DNS_RECORD',
  CERTIFICATE_NOT_VALID: 'CHECK_DNS_RECORD',
  WEB_PORTS_CLOSED: 'ADD_DOMAIN',
  ROUTE_NOT_APPLIED: 'WAIT_FOR_APPLY',
  NO_PUBLIC_ADDRESS: 'SET_PUBLIC_ADDRESS',
  SERVER_STALE: null,
}

const startable = (code: RemedyCode, app: MapApp): RemedyCode =>
  code === 'DEPLOY_TARGET' && app.status === 'stopped' ? 'START_TARGET' : code

export const findingPlan = (finding: Finding, apps: MapApp[], scope: Scope): FixPlan | null => {
  const code = findingRemedy[finding.code]

  if (!code) {
    return null
  }

  const details = finding.details ?? {}
  const app = apps.find((s) => s.name === details.app)

  if (!app) {
    return null
  }

  return planFix(
    {
      code: startable(code, app),
      text: finding.explanation,
    },
    {
      ...scope,
      subject: {
        kind: 'app',
        id: app.id,
        name: app.name,
      },
      server: text(details.server) ?? app.server_id,
    },
  )
}

export const errorRemedy: Partial<Record<ErrorCode, RemedyCode>> = {
  NO_CURRENT_DEPLOYMENT: 'DEPLOY_TARGET',
  MACHINE_NOT_RUNNING: 'START_TARGET',
}

const isErrorCode = (code: string): code is ErrorCode => Object.hasOwn(errorRemedy, code)

export const errorFix = (code: string, text: string): Fix | null => {
  const remedy = isErrorCode(code) ? errorRemedy[code] : undefined

  return remedy
    ? {
        code: remedy,
        text,
      }
    : null
}
