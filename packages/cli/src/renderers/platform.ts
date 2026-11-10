import { exitCodes } from '../errors.ts'
import type { Api, Data } from '../kit.ts'

type UpgradeView = Data<Api['platform']['upgrade']['post']>

type ReleaseUpgrade = Extract<UpgradeView, { release: object }>

const isRelease = (u: UpgradeView): u is ReleaseUpgrade =>
  'release' in u && typeof u.release !== 'string'

export const renderUpgrade = (u: UpgradeView) => {
  if (!isRelease(u)) return JSON.stringify(u, null, 2)
  const lines = [
    `${u.status === 'plan' ? 'plan' : u.status}: release ${u.release.from} -> ${u.release.to} (manifest ${short(u.release.manifest_digest)})${u.upgrade ? `, upgrade ${u.upgrade}` : ''}`,
  ]
  if (u.release.removed_overrides.length)
    lines.push(`overrides removed: ${u.release.removed_overrides.join(', ')}`)
  for (const c of u.changes)
    lines.push(
      `${String(c.order ?? '').padStart(2)}. ${c.component.padEnd(18)} ${`${c.from?.version ?? '-'} ${short(c.from?.digest ?? null)}`.padEnd(30)} -> ${`${c.to?.version ?? '-'} ${short(c.to?.digest ?? null)}`.padEnd(30)} ${c.procedure ?? ''}`,
    )
  for (const v of u.verification ?? []) {
    lines.push(
      `verified on ${v.station_id}: release-manifest.json ${v.release?.signature ?? '-'}${v.release?.identity ? ` (${v.release.identity})` : ''}`,
    )
    for (const i of v.items)
      lines.push(`  ${i.component.padEnd(18)} ${i.signature} ${i.duration_ms} ms`)
  }
  return lines.join('\n')
}

type DoctorView = Data<Api['doctor']['get']>

export const renderDoctor = (d: DoctorView) => {
  const lines = [`doctor ${d.status} at ${d.checked_at}`]
  for (const c of d.checks) {
    lines.push(
      `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(22)} ${(c.station ?? 'instance').padEnd(16)} ${c.code ? `[${c.code}] ` : ''}${c.finding}`,
    )
    if (c.fix && c.status !== 'ok') lines.push(`${''.padEnd(46)}fix: ${c.fix}`)
  }
  return lines.join('\n')
}

export const doctorExit = (d: DoctorView) => (d.status === 'fail' ? exitCodes.api : exitCodes.ok)

type InventoryView = Data<Api['inventory']['get']>

const short = (digest: string | null) => (digest ? digest.slice(0, 19) : '-')

export const renderInventory = (inv: InventoryView) => {
  const lines = [
    `release ${inv.release ? `${inv.release.version} (${short(inv.release.manifest_digest)})` : 'none'}`,
    '',
    'components',
  ]
  for (const c of inv.items)
    lines.push(
      `  ${(c.station_id ?? 'instance').padEnd(30)} ${c.name.padEnd(18)} ${c.version.padEnd(14)} ${short(c.digest).padEnd(20)} ${c.signature.padEnd(16)} ${c.status}${c.drift ? ` drift (lockfile ${c.lockfile_version})` : ''}`,
    )
  lines.push(
    '',
    `base images (checks ${inv.base_image_checks.enabled ? `every ${inv.base_image_checks.interval_s}s` : 'disabled'})`,
  )
  for (const b of inv.base_images)
    for (const c of b.checks)
      lines.push(
        `  ${b.ref.padEnd(40)} ${c.service.padEnd(16)} ${short(c.digest).padEnd(20)} ${c.check}${c.check === 'moved' ? ` -> ${short(c.latest_digest)} (sly services rebuild --service ${c.service})` : ''}`,
      )
  return lines.join('\n')
}
