import { isIPv4 } from 'node:net'

import { and, eq, isNull } from 'drizzle-orm'

import {
  dispatchAddress,
  gatewayHostAlias,
  networkLayout,
  type machineRuntimeValues,
  type SettingKey,
} from '@stationly/protocol'

import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { component, member, server } from '../db/schema.ts'
import { readSetting, storedSetting, writeSetting } from '../db/settings.ts'
import { DomainError } from '../errors.ts'
import { cidrProblem } from '../net/cidr.ts'
import {
  hostArch,
  lockfileFor,
  parseManifest,
  resolvePins,
  sha256Of,
  storeRelease,
} from '../platform/lockfile.ts'
import { runtimeRefusal } from '../sandboxes/runtime.ts'
import type { Keyring } from '../secrets/keyring.ts'

import {
  loginLinkSeconds,
  minPasswordLength,
  takeLoginLink,
  userExists,
  type AuthService,
} from './auth.ts'
import { checkHostnamePair } from './hostnames.ts'

export type SetupInput = {
  email: string
  password: string
  name?: string
  acme_email?: string
  hostnames?: { dashboard: string; api: string }
  'ipam.pool'?: string
  public_address?: string
  ingress?: 'direct' | 'tunnel'
  sandbox_runtime?: (typeof machineRuntimeValues)[number]
  release?: InstalledRelease | null
}

export type InstalledRelease = { manifest: string; bundle: string; source: string }

export type SetupActor = { type: 'system' | 'station'; id: string | null; client: string }

export class SetupError extends DomainError<
  'SETUP_DONE' | 'VALIDATION_FAILED' | 'HOSTNAME_DOMAIN_MISMATCH'
> {}

export const ensureInstanceId = (db: Db) => {
  if (storedSetting(db, 'instance.id') !== undefined) {
    return
  }

  writeSetting(db, 'instance.id', newId('instance'), {
    type: 'system',
    id: null,
    client: 'dispatch',
  })
}

export const setupInstance = async (
  deps: { db: Db; keyring: Keyring; auth: AuthService },
  input: SetupInput,
  actor: SetupActor,
) => {
  const { db, keyring, auth } = deps

  if (userExists(db)) {
    throw new SetupError('SETUP_DONE', 'An admin already exists; sly setup runs once.')
  }

  if (typeof input.email !== 'string' || !input.email.includes('@')) {
    throw new SetupError('VALIDATION_FAILED', 'The admin email is not an email address.')
  }

  if (typeof input.password !== 'string' || input.password.length < minPasswordLength) {
    throw new SetupError(
      'VALIDATION_FAILED',
      `The password needs at least ${minPasswordLength} characters.`,
    )
  }

  const settings: Partial<Record<SettingKey, unknown>> = {}
  const tunnel = input.ingress === 'tunnel'

  if (tunnel) {
    if (!input.hostnames) {
      throw new SetupError(
        'VALIDATION_FAILED',
        'Cloudflare Tunnel setup needs the dashboard and API hostnames.',
      )
    }

    for (const key of ['public_address', 'acme_email'] as const) {
      if (input[key] !== undefined) {
        throw new SetupError(
          'VALIDATION_FAILED',
          `${key} does not apply to Cloudflare Tunnel setup; leave it out.`,
        )
      }
    }
  }

  if (input.hostnames) {
    const check = checkHostnamePair(input.hostnames.dashboard, input.hostnames.api)

    if (!check.ok) {
      throw new SetupError('HOSTNAME_DOMAIN_MISMATCH', check.reason)
    }

    if (tunnel) {
      for (const host of [input.hostnames.dashboard, input.hostnames.api]) {
        if (host === check.commonParent) {
          throw new SetupError(
            'VALIDATION_FAILED',
            `${host} is the zone itself; use a name one label under it, such as dash.${host} and api.${host}.`,
          )
        }

        const label = host.slice(0, -(check.commonParent.length + 1))

        if (label.includes('.')) {
          throw new SetupError(
            'VALIDATION_FAILED',
            `${host} is more than one label under ${check.commonParent}, and the free Cloudflare certificate covers only one; use a flat name such as ${label.replaceAll('.', '-')}.${check.commonParent}.`,
          )
        }
      }

      settings['ingress.mode'] = 'tunnel'
      settings['domains.zone'] = check.commonParent
    }

    settings['hostnames.dashboard'] = input.hostnames.dashboard
    settings['hostnames.api'] = input.hostnames.api
    settings['auth.passkey_rp_id'] = check.commonParent
  }

  if (input.acme_email) {
    settings['acme.email'] = input.acme_email
  }

  if (input.public_address !== undefined && !isIPv4(input.public_address)) {
    throw new SetupError(
      'VALIDATION_FAILED',
      `public_address ${input.public_address} is not an IPv4 address in dotted-quad form.`,
    )
  }

  const host =
    actor.type === 'station' && actor.id
      ? db
          .select()
          .from(server)
          .where(and(eq(server.id, actor.id), eq(server.hosts_dispatch, true)))
          .get()
      : undefined

  for (const key of ['public_address', 'sandbox_runtime'] as const) {
    if (input[key] !== undefined && !host) {
      throw new SetupError(
        'VALIDATION_FAILED',
        `${key} needs the server that hosts Dispatch to have enrolled.`,
      )
    }
  }

  const runtimeProblem =
    host && input.sandbox_runtime !== undefined ? runtimeRefusal(host, input.sandbox_runtime) : null

  if (runtimeProblem) {
    throw new SetupError('VALIDATION_FAILED', `sandbox_runtime: ${runtimeProblem}.`)
  }

  const pool = input['ipam.pool']

  if (pool !== undefined) {
    const problem = cidrProblem(pool)

    if (problem) {
      throw new SetupError('VALIDATION_FAILED', `ipam.pool ${problem}.`)
    }

    const stored = storedSetting(db, 'ipam.pool')

    if (stored === undefined) {
      settings['ipam.pool'] = pool
    } else if (stored !== pool) {
      throw new SetupError(
        'VALIDATION_FAILED',
        `ipam.pool is ${stored} in Dispatch but the installer chose ${pool}.`,
      )
    }
  }

  ensureInstanceId(db)
  let manifest: ReturnType<typeof parseManifest> | null = null
  const release = input.release ?? null

  if (release) {
    try {
      manifest = parseManifest(release.manifest)
      JSON.parse(release.bundle)
    } catch (error) {
      throw new SetupError(
        'VALIDATION_FAILED',
        `The installed release is unreadable: ${(error as Error).message}`,
      )
    }

    settings['platform.lockfile'] = lockfileFor(manifest, sha256Of(release.manifest))
  }

  const created = await auth.current.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name ?? 'admin',
      role: 'admin',
      data: {
        emailVerified: true,
      },
    },
  })
  const userId = created.user.id

  db.transaction((tx) => {
    keyring.wrapForPassword(userId, input.password)

    if (host && (input.public_address !== undefined || input.sandbox_runtime !== undefined)) {
      tx.update(server)
        .set({
          public_address: input.public_address ?? host.public_address,
          default_machine_runtime: input.sandbox_runtime ?? host.default_machine_runtime,
        })
        .where(eq(server.id, host.id))
        .run()
    }

    for (const [key, value] of Object.entries(settings)) {
      writeSetting(tx, key as SettingKey, value, actor)
    }

    tx.insert(member)
      .values({
        user_id: userId,
        role: 'admin',
        joined_by: null,
        created_at: new Date(),
      })
      .onConflictDoNothing()
      .run()

    if (release && manifest) {
      storeRelease(tx, {
        manifestRaw: release.manifest,
        bundle: release.bundle,
        source: release.source,
        verifiedBy: 'stationd install',
      })

      for (const [name, pin] of Object.entries(resolvePins(manifest, null, hostArch()))) {
        const values = {
          name: name as (typeof component.$inferInsert)['name'],
          version: pin.version,
          digest: pin.digest,
          lockfile_version: pin.version,
          lockfile_digest: pin.digest,
          since: new Date(),
          signature: pin.kind === 'image' ? 'verified' : 'not_applicable',
        } satisfies typeof component.$inferInsert

        if (name === 'dispatch') {
          tx.update(component)
            .set({
              lockfile_version: pin.version,
              lockfile_digest: pin.digest,
              signature: values.signature,
            })
            .where(and(isNull(component.server_id), eq(component.name, 'dispatch')))
            .run()
        } else if (host) {
          tx.insert(component)
            .values({
              ...values,
              server_id: host.id,
            })
            .run()
        }
      }
    }

    recordAudit(tx, {
      actor,
      action: 'setup.admin_created',
      target: {
        entity: 'user',
        id: userId,
      },
      after: {
        email: input.email.toLowerCase(),
        settings: Object.keys(settings),
        public_address: input.public_address ?? null,
        ingress: input.ingress ?? 'direct',
        sandbox_runtime: input.sandbox_runtime ?? null,
        release: manifest?.release ?? null,
        components: Object.keys(manifest?.components ?? {}),
      },
    })
  })
  auth.rebuild()
  const surface = auth.surface

  await auth.current.api.signInMagicLink({
    body: {
      email: input.email,
      callbackURL: `${surface.dashboardOrigin}/`,
    },
    headers: new Headers(),
  })
  const minted = takeLoginLink(input.email)
  const loginLink = minted
    ? `${surface.dashboardOrigin}${new URL(minted).pathname}${new URL(minted).search}`
    : null
  const instanceId = readSetting(db, 'instance.id')!

  return {
    admin_user_id: userId,
    email: created.user.email,
    instance_id: instanceId,
    settings: Object.keys(settings),
    lockfile: settings['platform.lockfile']
      ? {
          release: manifest?.release ?? null,
          manifest_digest: release ? sha256Of(release.manifest) : null,
        }
      : null,
    login_link: loginLink,
    login_link_expires_at: new Date(Date.now() + loginLinkSeconds * 1000).toISOString(),
    public_address: input.public_address ?? null,
    hostnames: input.hostnames
      ? {
          ...input.hostnames,
          status: 'pending',
        }
      : null,
    reach: [
      ...(input.hostnames && tunnel
        ? [
            `https://${input.hostnames.dashboard} through the Cloudflare Tunnel once its *.${String(settings['domains.zone'])} route points at http://${gatewayHostAlias}`,
          ]
        : input.hostnames
          ? [
              `https://${input.hostnames.dashboard} once its DNS resolves and its certificate is issued`,
            ]
          : []),
      `ssh -L ${networkLayout.dispatchPort}:${dispatchAddress} <server>, then ${auth.localOrigin}; sign in with password, then enroll TOTP`,
    ],
  }
}
