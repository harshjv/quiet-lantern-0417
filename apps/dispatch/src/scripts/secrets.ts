import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { text } from 'node:stream/consumers'

import { Option, type Command } from 'commander'
import { and, eq } from 'drizzle-orm'

import { refreshStale, settleVariableWrites, staleDependents } from '../api/stale.ts'
import { openDb, type Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { environment, project, service, service_port, station } from '../db/schema.ts'
import {
  activateDeployment,
  createDeployment,
  generationEnv,
  secretsDeliver,
  snapshotVersions,
} from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { Keyring, masterKeyFromEnv, sameKey, unwrapWithPassword } from '../secrets/keyring.ts'
import {
  grantGlobal,
  readValue,
  resolvedView,
  setVariable,
  type VariableInput,
  type VariableWrite,
} from '../secrets/variables.ts'

const actor = {
  type: 'user' as const,
  id: 'usr_smoke',
  client: 'dispatch/secrets-cli',
}
const cliRequestId = () => `req_${randomBytes(8).toString('hex')}`

type SeedVariable = {
  scope: 'global' | 'project' | 'service'
  service?: string
  environment?: string
  key: string
  value: string
  sealed?: boolean
  injection?: 'env' | 'file'
  allow_unresolved?: boolean
  grant?: { alias?: string }
}

type Seed = {
  station: string
  project: string
  environments: { name: string; protected?: boolean }[]
  services: {
    name: string
    environment: string
    kind: 'web' | 'worker'
    ports?: number[]
    secrets_owner?: { uid: number; gid: number } | null
  }[]
  variables: SeedVariable[]
}

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
const stdinValue = async () => (await text(process.stdin)).replace(/\n$/, '')

const environmentNamed = (db: Db, name: string) => {
  const row = db.select().from(environment).where(eq(environment.name, name)).get()
  if (!row) throw new SecretsError('NOT_FOUND', `environment ${name} does not exist`)
  return row
}

const serviceNamed = (db: Db, name: string, environmentName: string) => {
  const env = environmentNamed(db, environmentName)
  const row = db
    .select()
    .from(service)
    .where(and(eq(service.environment_id, env.id), eq(service.name, name)))
    .get()
  if (!row)
    throw new SecretsError('NOT_FOUND', `service ${name} does not exist in ${environmentName}`)
  return row
}

const seed = (db: Db, keyring: Keyring, doc: Seed) => {
  const stationId = newId('station')
  db.insert(station)
    .values({
      id: stationId,
      name: doc.station,
    })
    .run()
  const projectId = newId('project')
  const envIds = Object.fromEntries(doc.environments.map((e) => [e.name, newId('environment')]))
  db.insert(project)
    .values({
      id: projectId,
      name: doc.project,
      default_environment_id: envIds[doc.environments[0]!.name]!,
      workshop_uid_base: 2_000_000,
      pr_environments: {
        enabled: false,
        source_environment_id: null,
      },
    })
    .run()
  for (const e of doc.environments) {
    db.insert(environment)
      .values({
        id: envIds[e.name]!,
        project_id: projectId,
        name: e.name,
        protected: e.protected ?? false,
      })
      .run()
  }
  const services: Record<
    string,
    { id: string; environment_id: string; ports: { id: string; port: number }[] }
  > = {}
  for (const s of doc.services) {
    const id = newId('service')
    db.insert(service)
      .values({
        id,
        environment_id: envIds[s.environment]!,
        name: s.name,
        kind: s.kind,
        station_id: stationId,
        source: {
          type: 'image',
          ref: 'smoke',
        },
        limits: {
          cpu_millis: 1000,
          memory_bytes: 268435456,
        },
        strategy: 'overlap',
        secrets_owner: s.secrets_owner ?? null,
        exports: s.kind === 'web' ? ['HOST', 'PORT', 'URL'] : ['HOST', 'PORT'],
      })
      .run()
    const ports = (s.ports ?? []).map((port) => {
      const portId = newId('service_port')
      db.insert(service_port)
        .values({
          id: portId,
          service_id: id,
          port,
          protocol: 'http',
        })
        .run()
      return {
        id: portId,
        port,
      }
    })
    services[s.name] = {
      id,
      environment_id: envIds[s.environment]!,
      ports,
    }
  }
  const writes: VariableWrite[] = []
  const variables = doc.variables.map((v) => {
    const input: VariableInput = {
      scope: v.scope,
      project_id: projectId,
      service_id: v.scope === 'service' ? services[v.service!]!.id : undefined,
      environment_id: v.scope === 'project' && v.environment ? envIds[v.environment]! : null,
      key: v.key,
      value: v.value,
      sealed: v.sealed,
      injection: v.injection,
      allow_unresolved: v.allow_unresolved,
      actor,
      request_id: cliRequestId(),
    }
    const result = setVariable(db, keyring, input)
    if (v.scope === 'global' && v.grant)
      grantGlobal(db, result.variable_id, projectId, v.grant.alias ?? null)
    if (result.write) writes.push(result.write)
    return {
      scope: v.scope,
      service: v.service,
      environment: v.environment,
      key: v.key,
      variable_id: result.variable_id,
      kind: result.kind,
      version: result.write?.version ?? null,
    }
  })
  settleVariableWrites(db, writes)
  return {
    station_id: stationId,
    project_id: projectId,
    environments: envIds,
    services,
    variables,
  }
}

type Context = { db: Db; keyring: Keyring; masterKey: Buffer }
type ServiceOptions = { service: string; environment: string }

const withDb =
  <A extends unknown[]>(fn: (context: Context, ...args: A) => unknown) =>
  async (...args: [...A, Command]) => {
    const command = args.at(-1) as Command
    try {
      const db = openDb(command.optsWithGlobals<{ db: string }>().db)
      const masterKey = masterKeyFromEnv()
      const result = await fn(
        {
          db,
          keyring: new Keyring(db, masterKey),
          masterKey,
        },
        ...(args.slice(0, -1) as A),
      )
      if (result !== undefined) print(result)
    } catch (error) {
      if (error instanceof SecretsError) {
        print({
          error: error.toJSON(),
        })
        process.exit(1)
      }
      throw error
    }
  }

const serviceCommand = (secrets: Command, name: string) =>
  secrets
    .command(name)
    .requiredOption('--service <name>', 'service name')
    .option('--environment <name>', 'environment name', 'production')

export const secretsCommand = (program: Command) => {
  const secrets = program
    .command('secrets')
    .description('Exercise the secrets core against a SQLite file')
    .requiredOption('--db <file>', 'SQLite file Dispatch owns')

  secrets
    .command('seed')
    .description(
      'Read a seed document on stdin; create the station, project, environments, services and variables',
    )
    .action(
      withDb(async ({ db, keyring }) =>
        seed(db, keyring, JSON.parse(await text(process.stdin)) as Seed),
      ),
    )

  serviceCommand(secrets, 'set')
    .description('Set a service variable to the value read on stdin')
    .argument('<KEY>', 'variable key')
    .option('--sealed', 'store the value sealed', false)
    .option('--file', 'inject the value as a file', false)
    .option('--allow-unresolved', 'accept references that do not resolve yet', false)
    .action(
      withDb(
        async (
          { db, keyring },
          key: string,
          options: ServiceOptions & { sealed: boolean; file: boolean; allowUnresolved: boolean },
        ) => {
          const svc = serviceNamed(db, options.service, options.environment)
          const result = setVariable(db, keyring, {
            scope: 'service',
            service_id: svc.id,
            key,
            value: await stdinValue(),
            sealed: options.sealed,
            injection: options.file ? 'file' : undefined,
            allow_unresolved: options.allowUnresolved,
            actor,
            request_id: cliRequestId(),
          })
          if (result.write) settleVariableWrites(db, [result.write])
          return {
            ...result,
            stale_dependents: staleDependents(db, null),
          }
        },
      ),
    )

  serviceCommand(secrets, 'resolved')
    .description('Print the resolved-variables view of a service')
    .option('--admin', 'the admin view', false)
    .action(
      withDb(({ db, keyring }, options: ServiceOptions & { admin: boolean }) =>
        resolvedView(db, keyring, serviceNamed(db, options.service, options.environment).id, {
          admin: options.admin,
        }),
      ),
    )

  serviceCommand(secrets, 'read')
    .description('Print the plaintext of a non-sealed variable')
    .argument('<KEY>', 'variable key')
    .action(
      withDb(({ db, keyring }, key: string, options: ServiceOptions) => ({
        value: readValue(
          db,
          keyring,
          serviceNamed(db, options.service, options.environment).id,
          key,
        ),
      })),
    )

  serviceCommand(secrets, 'deploy')
    .description('Create a deployment of a service and print its generation environment')
    .requiredOption('--image <ref>', 'image reference')
    .option('--out <file>', 'also write the generation environment to this file')
    .addOption(
      new Option('--trigger <trigger>', 'deployment trigger')
        .choices(['manual', 'variable_change', 'redeploy'] as const)
        .default('manual'),
    )
    .action(
      withDb(
        (
          { db },
          options: ServiceOptions & {
            image: string
            out?: string
            trigger: 'manual' | 'variable_change' | 'redeploy'
          },
        ) => {
          const svc = serviceNamed(db, options.service, options.environment)
          const created = createDeployment(db, {
            service_id: svc.id,
            image_ref: options.image,
            trigger: options.trigger,
            actor,
          })
          const fragment = generationEnv(db, created.deployment_id)
          if (options.out) writeFileSync(options.out, `${JSON.stringify(fragment, null, 2)}\n`)
          return fragment
        },
      ),
    )

  secrets
    .command('activate')
    .description('Activate a deployment and refresh the services it makes stale')
    .requiredOption('--deployment <id>', 'deployment id')
    .action(
      withDb(({ db }, options: { deployment: string }) => {
        const serviceId = activateDeployment(db, options.deployment)
        refreshStale(db, [serviceId])
        return db
          .select({
            id: service.id,
            stale: service.stale,
            stale_reasons: service.stale_reasons,
          })
          .from(service)
          .where(eq(service.id, serviceId))
          .get()
      }),
    )

  secrets
    .command('deliver')
    .description('Print the secrets.deliver body for stationd')
    .requiredOption('--deployment <id>', 'deployment id')
    .addOption(
      new Option('--purpose <purpose>', 'delivery purpose')
        .choices(['deploy', 'redaction'] as const)
        .default('deploy'),
    )
    .action(
      withDb(
        ({ db, keyring }, options: { deployment: string; purpose: 'deploy' | 'redaction' }) => {
          process.stdout.write(
            `${JSON.stringify(secretsDeliver(db, keyring, options.deployment, options.purpose, actor))}\n`,
          )
        },
      ),
    )

  secrets
    .command('versions')
    .description('Print the pinned variable versions of a deployment')
    .requiredOption('--deployment <id>', 'deployment id')
    .action(
      withDb(({ db }, options: { deployment: string }) => snapshotVersions(db, options.deployment)),
    )

  secrets
    .command('password-wrap')
    .description("Wrap the master key under the user's password read on stdin")
    .requiredOption('--user <id>', 'user id')
    .action(
      withDb(async ({ keyring }, options: { user: string }) => ({
        master_key_wrap_id: keyring.wrapForPassword(options.user, await stdinValue()),
      })),
    )

  secrets
    .command('password-unwrap')
    .description('Report whether the password read on stdin unwraps the running master key')
    .requiredOption('--user <id>', 'user id')
    .action(
      withDb(async ({ db, masterKey }, options: { user: string }) => ({
        unwraps_running_key: sameKey(
          unwrapWithPassword(db, options.user, await stdinValue()),
          masterKey,
        ),
      })),
    )
}
