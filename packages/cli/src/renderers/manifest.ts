import type { Api, Data } from '../kit.ts'

type Plan = Data<ReturnType<Api['projects']>['manifest']['apply']['post']>

type Change = Plan['changes'][number]

const short = (value: unknown) => {
  const text = JSON.stringify(value)
  return text === undefined ? 'null' : text.length > 80 ? `${text.slice(0, 77)}...` : text
}

const label = (change: Change) => {
  const after = (change.after ?? change.before ?? {}) as {
    name?: string
    key?: string
    hostname?: string
    mount_path?: string
    port?: number
    host_port?: number
  }
  const name =
    after.name ??
    after.key ??
    after.hostname ??
    after.mount_path ??
    (after.port !== undefined ? `port ${after.port}` : undefined) ??
    (after.host_port !== undefined ? `host port ${after.host_port}` : undefined)
  return `${change.entity}${name !== undefined ? ` ${name}` : ''}`
}

export const renderPlan = (plan: Plan) => {
  const lines: string[] = []
  const names = new Map<string, string>()
  for (const change of plan.changes)
    if (change.op === 'add' && change.ref) names.set(change.ref, label(change))
  for (const change of plan.changes) {
    if (change.op === 'add' && change.entity === 'deployment') {
      const after = change.after as { trigger: { type: string }; reason?: string }
      lines.push(
        `+ deployment of ${names.get(change.parent ?? '') ?? change.parent} (${after.trigger.type}${after.reason ? `: ${after.reason}` : ''})`,
      )
    } else if (change.op === 'add')
      lines.push(
        `+ ${label(change)}${change.parent && names.has(change.parent) ? ` in ${names.get(change.parent)}` : ''}`,
      )
    else if (change.op === 'remove') lines.push(`- ${label(change)} ${change.id}`)
    else
      lines.push(
        `~ ${names.get(change.id ?? '') ?? `${change.entity} ${change.id}`} ${change.path || ''}: ${change.entity === 'variable' ? 'value or settings change' : `${short(change.before)} -> ${short(change.after)}`}`,
      )
  }
  const summary = {
    add: plan.changes.filter((c) => c.op === 'add' && c.entity !== 'deployment').length,
    update: plan.changes.filter((c) => c.op === 'update').length,
    remove: plan.changes.filter((c) => c.op === 'remove').length,
    deployments: plan.changes.filter((c) => c.op === 'add' && c.entity === 'deployment').length,
  }
  const out = [
    lines.length ? lines.join('\n') : 'no changes',
    '',
    `${plan.status}: ${summary.add} to add, ${summary.update} to change, ${summary.remove} to remove, ${summary.deployments} deployments${plan.id ? ` (${plan.id})` : ''}`,
  ]
  if (plan.unmanaged?.length)
    out.push(
      '',
      `unmanaged (left in place; --prune removes them):`,
      ...plan.unmanaged.map(
        (u) =>
          `  ${u.entity} ${u.name ?? u.key ?? u.hostname ?? u.mount_path ?? u.port ?? ''}${u.service ? ` of ${u.service}` : ''} ${u.id}`,
      ),
    )
  if (plan.warnings?.length)
    out.push(
      '',
      'warnings:',
      ...plan.warnings.map((w) => `  ${w.code}${w.path ? ` ${w.path}` : ''}: ${w.explanation}`),
    )
  return out.join('\n')
}
