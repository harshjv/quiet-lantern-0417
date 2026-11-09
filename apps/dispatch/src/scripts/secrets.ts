import { randomBytes } from 'node:crypto'
import { text } from 'node:stream/consumers'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { openDb, type Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { environment, project, service, service_port, station } from '../db/schema.ts'
import { activateDeployment, createDeployment, generationEnv, secretsDeliver, snapshotVersions } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { Keyring, masterKeyFromEnv, sameKey, unwrapWithPassword } from '../secrets/keyring.ts'
import { grantGlobal, readValue, resolvedView, setVariable, type VariableInput, type VariableWrite } from '../secrets/variables.ts'
import { refreshStale, settleVariableWrites, staleDependents } from '../api/stale.ts'

const actor = { type: 'user' as const, id: 'usr_smoke', client: 'dispatch/secrets-cli' }
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
  services: { name: string; environment: string; kind: 'web' | 'worker'; ports?: number[]; secrets_owner?: { uid: number; gid: number } | null }[]
  variables: SeedVariable[]
}

const usage = `usage: pnpm secrets <command> --db <sqlite file> [options]
  seed                         read a seed document on stdin; create station, project, environments, services, variables
  set --service <name> <KEY>   read the value on stdin [--sealed] [--file] [--allow-unresolved] [--environment <name>]
  resolved --service <name>    the resolved-variables view [--admin]
  read --service <name> <KEY>  the plaintext of a non-sealed variable
  deploy --service <name> --image <ref> [--out <file>] [--trigger manual|variable_change|redeploy]
  activate --deployment <id>
  deliver --deployment <id>    the secrets.deliver body for stationd on stdout [--purpose deploy|redaction]
  versions --deployment <id>   the pinned versions of a deployment
  password-wrap --user <id>    read the password on stdin, wrap the master key under it
  password-unwrap --user <id>  read the password on stdin, report whether it unwraps the running master key`

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    service: { type: 'string' },
    environment: { type: 'string', default: 'production' },
    image: { type: 'string' },
    out: { type: 'string' },
    trigger: { type: 'string', default: 'manual' },
    deployment: { type: 'string' },
    purpose: { type: 'string', default: 'deploy' },
    user: { type: 'string' },
    sealed: { type: 'boolean', default: false },
    file: { type: 'boolean', default: false },
    admin: { type: 'boolean', default: false },
    'allow-unresolved': { type: 'boolean', default: false }
  }
})

const [command, ...rest] = positionals
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
const need = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new SecretsError('VALIDATION_FAILED', `--${name} is required`)
  return value
}
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
  if (!row) throw new SecretsError('NOT_FOUND', `service ${name} does not exist in ${environmentName}`)
  return row
}

const seed = (db: Db, keyring: Keyring, doc: Seed) => {
  const stationId = newId('station')
  db.insert(station).values({ id: stationId, name: doc.station }).run()
  const projectId = newId('project')
  const envIds = Object.fromEntries(doc.environments.map(e => [e.name, newId('environment')]))
  db.insert(project)
    .values({
      id: projectId,
      name: doc.project,
      default_environment_id: envIds[doc.environments[0]!.name]!,
      workshop_uid_base: 2_000_000,
      pr_environments: { enabled: false, source_environment_id: null }
    })
    .run()
  for (const e of doc.environments) {
    db.insert(environment)
      .values({ id: envIds[e.name]!, project_id: projectId, name: e.name, protected: e.protected ?? false })
      .run()
  }
  const services: Record<string, { id: string; environment_id: string; ports: { id: string; port: number }[] }> = {}
  for (const s of doc.services) {
    const id = newId('service')
    db.insert(service)
      .values({
        id,
        environment_id: envIds[s.environment]!,
        name: s.name,
        kind: s.kind,
        station_id: stationId,
        source: { type: 'image', ref: 'smoke' },
        limits: { cpu_millis: 1000, memory_bytes: 268435456 },
        strategy: 'overlap',
        secrets_owner: s.secrets_owner ?? null,
        exports: s.kind === 'web' ? ['HOST', 'PORT', 'URL'] : ['HOST', 'PORT']
      })
      .run()
    const ports = (s.ports ?? []).map(port => {
      const portId = newId('service_port')
      db.insert(service_port).values({ id: portId, service_id: id, port, protocol: 'http' }).run()
      return { id: portId, port }
    })
    services[s.name] = { id, environment_id: envIds[s.environment]!, ports }
  }
  const writes: VariableWrite[] = []
  const variables = doc.variables.map(v => {
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
      request_id: cliRequestId()
    }
    const result = setVariable(db, keyring, input)
    if (v.scope === 'global' && v.grant) grantGlobal(db, result.variable_id, projectId, v.grant.alias ?? null)
    if (result.write) writes.push(result.write)
    return { scope: v.scope, service: v.service, environment: v.environment, key: v.key, variable_id: result.variable_id, kind: result.kind, version: result.write?.version ?? null }
  })
  settleVariableWrites(db, writes)
  return { station_id: stationId, project_id: projectId, environments: envIds, services, variables }
}

const main = async () => {
  if (!command) {
    console.error(usage)
    process.exit(2)
  }
  const db = openDb(need(flags.db, 'db'))
  const masterKey = masterKeyFromEnv()
  const keyring = new Keyring(db, masterKey)
  switch (command) {
    case 'seed':
      return print(seed(db, keyring, JSON.parse(await text(process.stdin)) as Seed))
    case 'set': {
      const key = need(rest[0], 'KEY')
      const svc = serviceNamed(db, need(flags.service, 'service'), flags.environment!)
      const result = setVariable(db, keyring, {
        scope: 'service',
        service_id: svc.id,
        key,
        value: await stdinValue(),
        sealed: flags.sealed,
        injection: flags.file ? 'file' : undefined,
        allow_unresolved: flags['allow-unresolved'],
        actor,
        request_id: cliRequestId()
      })
      if (result.write) settleVariableWrites(db, [result.write])
      return print({ ...result, stale_dependents: staleDependents(db, null) })
    }
    case 'resolved':
      return print(resolvedView(db, keyring, serviceNamed(db, need(flags.service, 'service'), flags.environment!).id, { admin: flags.admin! }))
    case 'read':
      return print({ value: readValue(db, keyring, serviceNamed(db, need(flags.service, 'service'), flags.environment!).id, need(rest[0], 'KEY')) })
    case 'deploy': {
      const svc = serviceNamed(db, need(flags.service, 'service'), flags.environment!)
      const created = createDeployment(db, {
        service_id: svc.id,
        image_ref: need(flags.image, 'image'),
        trigger: flags.trigger as 'manual' | 'variable_change' | 'redeploy',
        actor
      })
      const fragment = generationEnv(db, created.deployment_id)
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(fragment, null, 2)}\n`)
      return print(fragment)
    }
    case 'activate': {
      const serviceId = activateDeployment(db, need(flags.deployment, 'deployment'))
      refreshStale(db, [serviceId])
      return print(db.select({ id: service.id, stale: service.stale, stale_reasons: service.stale_reasons }).from(service).where(eq(service.id, serviceId)).get())
    }
    case 'deliver':
      return process.stdout.write(
        `${JSON.stringify(secretsDeliver(db, keyring, need(flags.deployment, 'deployment'), flags.purpose as 'deploy' | 'redaction', actor))}\n`
      )
    case 'versions':
      return print(snapshotVersions(db, need(flags.deployment, 'deployment')))
    case 'password-wrap':
      return print({ master_key_wrap_id: keyring.wrapForPassword(need(flags.user, 'user'), await stdinValue()) })
    case 'password-unwrap':
      return print({ unwraps_running_key: sameKey(unwrapWithPassword(db, need(flags.user, 'user'), await stdinValue()), masterKey) })
    default:
      console.error(usage)
      process.exit(2)
  }
}

main().catch(error => {
  if (error instanceof SecretsError) {
    process.stdout.write(`${JSON.stringify({ error: error.toJSON() }, null, 2)}\n`)
    process.exit(1)
  }
  throw error
})
