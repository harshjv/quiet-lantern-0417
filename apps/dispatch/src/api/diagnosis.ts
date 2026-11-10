import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'

import { remedy, type Diagnosis, type RemedyCode } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { build, deployment, deployment_step, run, service } from '../db/schema.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { leaves } from '../secrets/resolve.ts'

import type { Redactor } from './redaction.ts'

type DiagnosisValue = Static<typeof Diagnosis>
type DeploymentRow = typeof deployment.$inferSelect
type BuildRow = typeof build.$inferSelect
type RunRow = typeof run.$inferSelect
type Fix = NonNullable<DiagnosisValue['fixes']>[number]

const maxBytes = 16 * 1024
const maxLines = 80
const maxLineChars = 400
const errorPattern =
  /error|panic|fatal|exception|EADDRINUSE|ECONNREFUSED|permission denied|out of memory|" 5\d\d /i
const configPaths = [
  'limits',
  'command',
  'health',
  'strategy',
  'pre_deploy',
  'readonly_rootfs',
  'drain_timeout_s',
  'source',
]

const shapeLogs = (logs: DiagnosisValue['logs'], redact: Redactor): DiagnosisValue['logs'] => {
  if (!logs) return undefined
  const lines = logs.untrusted.text.split('\n')
  const tail = lines.slice(-40)
  const matches = lines
    .slice(0, -40)
    .filter((l) => errorPattern.test(l))
    .slice(-40)
  const picked = [...matches, ...tail].slice(-maxLines).map((l) => redact(l).slice(0, maxLineChars))
  return {
    ...logs,
    untrusted: {
      source: logs.untrusted.source,
      text: picked.join('\n'),
    },
    truncated: logs.truncated || lines.length > picked.length,
  }
}

const versionsOf = (snapshot: EnvSnapshot | undefined) => {
  const out = new Map<string, number>()
  for (const entry of snapshot?.entries ?? []) {
    for (const leaf of leaves(entry.node))
      if (leaf.kind === 'value')
        out.set(entry.key === leaf.key ? entry.key : `${entry.key}<-${leaf.key}`, leaf.version)
  }
  return out
}

const diffFrom = (db: Db, dep: DeploymentRow): DiagnosisValue['diff_from_last_good'] => {
  const good = db
    .select()
    .from(deployment)
    .where(
      and(
        eq(deployment.service_id, dep.service_id),
        inArray(deployment.status, ['active', 'superseded']),
        lt(deployment.id, dep.id),
      ),
    )
    .orderBy(desc(deployment.id))
    .limit(1)
    .get()
  if (!good) return undefined
  const from = versionsOf(good.env_snapshot as EnvSnapshot)
  const to = versionsOf(dep.env_snapshot as EnvSnapshot)
  const variables = [...new Set([...from.keys(), ...to.keys()])]
    .filter((k) => from.get(k) !== to.get(k))
    .map((k) => ({
      key: k,
      from_version: from.get(k) ?? 0,
      to_version: to.get(k) ?? 0,
    }))
  const config = configPaths
    .filter(
      (p) =>
        JSON.stringify(good.config_snapshot[p] ?? null) !==
        JSON.stringify(dep.config_snapshot[p] ?? null),
    )
    .map((p) => ({
      path: p,
      from: good.config_snapshot[p] ?? null,
      to: dep.config_snapshot[p] ?? null,
    }))
  const fromSha = good.trigger.source_sha
  const toSha = dep.trigger.source_sha
  const goodImages = new Map(good.base_images.map((b) => [b.ref, b.digest]))
  const base_images = dep.base_images
    .filter((b) => goodImages.has(b.ref) && goodImages.get(b.ref) !== b.digest)
    .map((b) => ({
      ref: b.ref,
      from: goodImages.get(b.ref)!,
      to: b.digest,
    }))
  return {
    deployment_id: good.id,
    ...(fromSha && toSha && fromSha !== toSha
      ? {
          source: {
            from_sha: fromSha,
            to_sha: toSha,
            files_changed: 0,
          },
        }
      : {}),
    ...(variables.length
      ? {
          variables,
        }
      : {}),
    ...(config.length
      ? {
          config,
        }
      : {}),
    ...(base_images.length
      ? {
          base_images,
        }
      : {}),
  }
}

const remedies = (dep: DeploymentRow, d: DiagnosisValue, serviceName: string): Fix[] => {
  const fixes: Fix[] = [...(d.fixes ?? [])]
  const has = (code: RemedyCode) => fixes.some((f) => f.code === code)
  const limits = dep.config_snapshot.limits as
    { memory_bytes: number; cpu_millis: number } | undefined
  if (d.code === 'OOM_KILLED' && limits) {
    const memory = limits.memory_bytes * 2
    const raise = remedy(
      'RAISE_MEMORY',
      `The kernel killed the process at its ${limits.memory_bytes}-byte limit. Raise limits.memory_bytes to at least ${memory}.`,
      {
        tool: 'update_service',
        input: {
          service: dep.service_id,
          limits: {
            ...limits,
            memory_bytes: memory,
          },
        },
      },
    )
    const at = fixes.findIndex((f) => f.code === 'RAISE_MEMORY')
    if (at >= 0) fixes[at] = raise
    else fixes.unshift(raise)
  }
  if (d.code === 'HEALTH_TIMEOUT' && !has('CHECK_HEALTH_PATH')) {
    const health = dep.config_snapshot.health as { path?: string; port?: number } | null
    fixes.push(
      remedy(
        'CHECK_HEALTH_PATH',
        `Confirm ${serviceName} listens on ${health?.port ?? 'its port'} on all interfaces and answers ${health?.path ?? 'the health check'}.`,
      ),
    )
  }
  if (d.code === 'EXIT_NONZERO' && !has('READ_LOGS'))
    fixes.push(
      remedy(
        'READ_LOGS',
        'The container exited before it was healthy. Read the log excerpt; get_logs with the cursor shows more.',
      ),
    )
  if (d.code === 'BUILD_FAILED' && !has('READ_BUILD_LOGS'))
    fixes.push(
      remedy(
        'READ_BUILD_LOGS',
        'Read the build log with get_logs and fix the Dockerfile or source, then deploy again.',
      ),
    )
  if (d.diff_from_last_good && !has('ROLLBACK')) {
    fixes.push(
      remedy(
        'ROLLBACK',
        `Deployment ${d.diff_from_last_good.deployment_id} was the last good one; rolling back restores it while you fix this.`,
        {
          tool: 'rollback',
          input: {
            service: dep.service_id,
            deployment_id: d.diff_from_last_good.deployment_id,
          },
        },
      ),
    )
  }
  return fixes
}

const bound = (d: DiagnosisValue) => {
  let out = d
  while (Buffer.byteLength(JSON.stringify(out)) > maxBytes && out.logs) {
    const lines = out.logs.untrusted.text.split('\n')
    if (lines.length <= 1) {
      out = {
        ...out,
        logs: undefined,
      }
      break
    }
    out = {
      ...out,
      logs: {
        ...out.logs,
        untrusted: {
          ...out.logs.untrusted,
          text: lines.slice(Math.ceil(lines.length / 4)).join('\n'),
        },
        truncated: true,
      },
    }
  }
  return out
}

export const deploymentDiagnosis = (
  db: Db,
  dep: DeploymentRow,
  redact: Redactor,
): DiagnosisValue | null => {
  if (dep.status !== 'failed') return null
  const svc = db
    .select({
      name: service.name,
    })
    .from(service)
    .where(eq(service.id, dep.service_id))
    .get()
  const b: BuildRow | undefined = dep.build_id
    ? db.select().from(build).where(eq(build.id, dep.build_id)).get()
    : undefined
  const base: DiagnosisValue = dep.failure ??
    b?.failure ?? {
      phase: 'start',
      code: 'EXIT_NONZERO',
      summary: `deployment ${dep.number} failed without a recorded cause`,
    }
  const steps = db
    .select()
    .from(deployment_step)
    .where(eq(deployment_step.deployment_id, dep.id))
    .orderBy(asc(deployment_step.created_at))
    .all()
  const events = steps
    .filter((s) => s.status !== 'pending')
    .map((s) => ({
      at: (s.finished_at ?? s.started_at ?? s.updated_at).toISOString(),
      step: s.step,
      status: s.status,
    }))
  const d: DiagnosisValue = {
    ...base,
    entity: {
      type: 'deployment',
      id: dep.id,
    },
    logs: shapeLogs(base.logs ?? b?.failure?.logs, redact),
    ...(events.length
      ? {
          events,
        }
      : {}),
  }
  const diff = diffFrom(db, dep)
  if (diff) d.diff_from_last_good = diff
  d.fixes = remedies(dep, d, svc?.name ?? dep.service_id)
  if (!d.logs) delete d.logs
  return bound(d)
}

export const buildDiagnosis = (b: BuildRow, redact: Redactor): DiagnosisValue | null => {
  if (b.status !== 'failed') return null
  const base: DiagnosisValue = b.failure ?? {
    phase: 'build',
    code: 'BUILD_FAILED',
    summary: `build ${b.id} failed without a recorded cause`,
  }
  const d: DiagnosisValue = {
    ...base,
    entity: {
      type: 'build',
      id: b.id,
    },
    logs: shapeLogs(base.logs, redact),
  }
  if (!d.logs) delete d.logs
  d.fixes = d.fixes?.length
    ? d.fixes
    : [
        remedy(
          'READ_BUILD_LOGS',
          'Read the build log with get_logs (build) and fix the Dockerfile or source, then deploy again.',
        ),
      ]
  return bound(d)
}

export const runDiagnosis = (r: RunRow, redact: Redactor): DiagnosisValue | null => {
  if (r.status !== 'failed') return null
  const base: DiagnosisValue = r.failure ?? {
    phase: 'run',
    code: 'EXIT_NONZERO',
    summary: `run ${r.id} failed with exit code ${r.exit_code}`,
  }
  const d: DiagnosisValue = {
    ...base,
    entity: {
      type: 'run',
      id: r.id,
    },
    exit_code: r.exit_code,
    logs: shapeLogs(base.logs, redact),
  }
  if (!d.logs) delete d.logs
  return bound(d)
}
