import type { ErrorCode, RemedyCode } from '@stationly/protocol'
import { bytesText } from '@stationly/protocol/format'

import type { NetworkMap } from './api.ts'
import { commands, type Scope, type ServiceScope } from './commands.ts'

export type Fix = {
  code: string
  text: string
  action?: {
    tool: string
    input: Record<string, unknown>
  }
}

export type Subject = {
  kind: 'service' | 'sandbox'
  id: string
  name: string
}

export type FixContext = Scope & {
  subject: Subject
  names?: Record<string, string>
  deployment?: {
    id: string
    build: boolean
  }
  station?: string
}

export type Run = {
  name: string
} & (
  | {
      tool: 'deploy'
      service: string
    }
  | {
      tool: 'start_service'
      service: string
    }
  | {
      tool: 'rollback'
      service: string
      deployment: string
    }
  | {
      tool: 'update_service'
      service: string
      body: Record<string, unknown>
    }
  | {
      tool: 'start_sandbox'
      sandbox: string
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
  scope: ServiceScope
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
      service: target.id,
    },
  }),
  command: ({ target }) => commands.deploy(target.scope),
}

const startService: Remedy = {
  ask: ({ target }) => `start ${target.name} and check that it becomes healthy`,
  button: ({ target }) => ({
    label: `Start ${target.name}`,
    run: {
      tool: 'start_service',
      name: target.name,
      service: target.id,
    },
  }),
  command: ({ target }) => commands.startService(target.scope),
}

const startSandbox: Remedy = {
  ask: ({ target }) => `start the sandbox ${target.name}`,
  button: ({ target }) => ({
    label: `Start ${target.name}`,
    run: {
      tool: 'start_sandbox',
      name: target.name,
      sandbox: target.id,
    },
  }),
  command: ({ target, context }) => commands.startSandbox(context, target.name),
}

const starter = ({ target }: Input) => (target.kind === 'sandbox' ? startSandbox : startService)

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
              tool: 'update_service',
              name: target.name,
              service: target.id,
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
              service: target.id,
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
    ask: ({ context }) =>
      `make ${context.subject.name} reach the other service by its .internal name`,
  },
  ATTACH_SHARED: {
    ask: ({ context }) => `attach the shared service ${context.subject.name} needs`,
  },
  EXPOSE_TCP: {
    ask: ({ target, input }) =>
      `expose ${target.name}’s TCP port${count(input.port) === null ? '' : ` ${count(input.port)}`} on the station`,
    command: ({ target, input }) => commands.exposeTcp(target.scope, count(input.port)),
  },
  ADD_DOMAIN: {
    ask: ({ target }) => `add a direct domain to ${target.name}`,
    command: ({ target }) => commands.addDomain(target.scope, null),
  },
  WAIT_FOR_APPLY: {
    ask: ({ target }) =>
      `find out why the station hasn’t applied ${target.name}’s latest settings and fix what blocks it`,
  },
  CHECK_DNS_RECORD: {
    ask: ({ target }) =>
      `check the DNS records of ${target.name}’s domains and point them at the station’s public address`,
  },
  SET_PUBLIC_ADDRESS: {
    ask: () => 'set the station’s public address',
    command: ({ context }) => (context.station ? commands.setPublicAddress(context.station) : null),
  },
  RUN_PROBE: {
    ask: ({ context, input }) =>
      `send a test connection from ${context.subject.name} to ${text(input.to) ?? 'the target'} and tell me whether it answers`,
    command: ({ context, input }) => {
      const to = text(input.to)
      return to && context.subject.kind === 'service'
        ? commands.probe(
            {
              ...context,
              service: context.subject.name,
            },
            to,
            count(input.port),
          )
        : null
    },
  },
  ALLOW_DOMAIN: {
    ask: ({ context }) =>
      `add the destination to the sandbox ${context.subject.name}’s outbound allowlist`,
  },
  JOIN_ENVIRONMENT: {
    ask: ({ context }) =>
      `move the sandbox ${context.subject.name} onto the environment network so it can reach services`,
  },
}

const isRemedy = (code: string): code is RemedyCode => Object.hasOwn(remedies, code)

const targetOf = (fix: Fix, context: FixContext): Target => {
  const input = fix.action?.input ?? {}
  const sandbox = text(input.sandbox)
  const id = text(input.service) ?? sandbox ?? context.subject.id
  const name =
    id === context.subject.id ? context.subject.name : (context.names?.[id] ?? context.subject.name)
  return {
    kind: sandbox ? 'sandbox' : id === context.subject.id ? context.subject.kind : 'service',
    id,
    name,
    scope: {
      project: context.project,
      environment: context.environment,
      service: name,
    },
  }
}

const prompt = (ask: string, context: FixContext) =>
  `In ${context.project}/${context.environment} on Stationly, ${ask}${/[.!?]$/.test(ask) ? '' : '.'}`

export const planFix = (fix: Fix, context: FixContext): FixPlan => {
  const target = targetOf(fix, context)
  const tool = fix.action?.tool ?? null
  if (!isRemedy(fix.code))
    return {
      code: fix.code,
      text: fix.text,
      button: null,
      command: null,
      prompt: prompt(`help me with this: ${fix.text}`, context),
      tool,
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
type MapService = NetworkMap['services'][number]

export const findingRemedy: Record<FindingCode, RemedyCode | null> = {
  SWITCH_NO_TARGET: 'DEPLOY_TARGET',
  SWITCH_PENDING: 'WAIT_FOR_APPLY',
  SWITCH_MISMATCH: 'WAIT_FOR_APPLY',
  NAME_NOT_IN_ENVIRONMENT: 'USE_INTERNAL_NAME',
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
  STATION_STALE: null,
}

const startable = (code: RemedyCode, service: MapService): RemedyCode =>
  code === 'DEPLOY_TARGET' && service.status === 'stopped' ? 'START_TARGET' : code

export const findingPlan = (
  finding: Finding,
  services: MapService[],
  scope: Scope,
): FixPlan | null => {
  const code = findingRemedy[finding.code]
  if (!code) return null
  const details = finding.details ?? {}
  const service = services.find((s) => s.name === details.service)
  if (!service) return null
  return planFix(
    {
      code: startable(code, service),
      text: finding.explanation,
    },
    {
      ...scope,
      subject: {
        kind: 'service',
        id: service.id,
        name: service.name,
      },
      station: text(details.station) ?? service.station_id,
    },
  )
}

export const errorRemedy: Partial<Record<ErrorCode, RemedyCode>> = {
  NO_CURRENT_DEPLOYMENT: 'DEPLOY_TARGET',
  SANDBOX_NOT_RUNNING: 'START_TARGET',
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
