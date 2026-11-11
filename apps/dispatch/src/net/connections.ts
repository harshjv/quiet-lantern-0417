import type { Static } from '@sinclair/typebox'
import { inArray } from 'drizzle-orm'

import type { MessageBody } from '@stationly/protocol'

import type { Redaction, SandboxRedaction } from '../api/redaction.ts'
import type { NetworkConnections, SandboxConnections } from '../api/shapes.ts'
import type { ActorValue } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { sandbox, service } from '../db/schema.ts'

export type StationSample = MessageBody<'network.sample.result'>['samples'][number]

export type ConnectionsDoc = Static<typeof NetworkConnections>

export type SandboxConnectionsDoc = Static<typeof SandboxConnections>

export type Direction = 'in' | 'out'

export type ShapeContext = { db: Db; redaction: Redaction; actor: ActorValue; requestId: string }

const namesOf = (db: Db, ids: Set<string>) =>
  new Map(
    (ids.size
      ? db
          .select({
            id: service.id,
            name: service.name,
          })
          .from(service)
          .where(inArray(service.id, [...ids]))
          .all()
      : []
    ).map((r) => [r.id, r.name]),
  )

const sandboxNamesOf = (db: Db, ids: Set<string>) =>
  new Map(
    (ids.size
      ? db
          .select({
            id: sandbox.id,
            name: sandbox.name,
          })
          .from(sandbox)
          .where(inArray(sandbox.id, [...ids]))
          .all()
      : []
    ).map((r) => [r.id, r.name]),
  )

const shapeConnections = (
  s: StationSample,
  names: Map<string, string>,
  boxes: Map<string, string>,
  direction?: Direction,
) =>
  s.connections
    .filter((c) => !direction || c.direction === direction)
    .map((c) => {
      const { kind, service_id, sandbox_id, deployment_id, address } = c.peer
      const peer: ConnectionsDoc['connections'][number]['peer'] = {
        kind,
      }

      if (service_id !== undefined) {
        peer.service_id = service_id
        peer.service = names.get(service_id) ?? service_id
      }

      if (sandbox_id !== undefined) {
        peer.sandbox_id = sandbox_id
        peer.sandbox = boxes.get(sandbox_id) ?? sandbox_id
      }

      if (deployment_id !== undefined) {
        peer.deployment_id = deployment_id
      }

      if (address !== undefined) {
        peer.address = address
      }

      return {
        ...c,
        peer,
      }
    })

export const shapeSandboxSample = (
  ctx: ShapeContext & { sandboxRedaction: SandboxRedaction },
  s: StationSample,
  row: { id: string; name: string },
  direction?: Direction,
): SandboxConnectionsDoc => {
  const peers = new Set(
    s.connections.flatMap((c) => (c.peer.service_id ? [c.peer.service_id] : [])),
  )
  const boxes = new Set(
    s.connections.flatMap((c) => (c.peer.sandbox_id ? [c.peer.sandbox_id] : [])),
  )
  const redact = ctx.sandboxRedaction([row.id], ctx.actor, ctx.requestId)

  return {
    sandbox: {
      id: row.id,
      name: row.name,
    },
    at: s.at,
    conntrack: s.conntrack,
    connections: shapeConnections(
      s,
      namesOf(ctx.db, peers),
      sandboxNamesOf(ctx.db, boxes),
      direction,
    ),
    refused: s.refused,
    refused_truncated: s.refused_truncated,
    untrusted: {
      source: 'resolver answers' as const,
      names: Object.fromEntries(
        Object.entries(s.names).map(([address, name]) => [address, redact(name)]),
      ),
    },
  }
}

export const shapeSamples = (
  ctx: ShapeContext,
  samples: StationSample[],
  direction?: Direction,
): ConnectionsDoc[] => {
  const ids = new Set<string>()
  const boxIds = new Set<string>()

  for (const s of samples) {
    ids.add(s.service_id!)

    for (const c of s.connections) {
      if (c.peer.service_id) {
        ids.add(c.peer.service_id)
      }

      if (c.peer.sandbox_id) {
        boxIds.add(c.peer.sandbox_id)
      }
    }
  }

  const names = namesOf(ctx.db, ids)
  const boxes = sandboxNamesOf(ctx.db, boxIds)

  return samples.map((s) => {
    const redact = ctx.redaction(s.deployment_id ? [s.deployment_id] : [], ctx.actor, ctx.requestId)
    const connections = shapeConnections(s, names, boxes, direction)

    return {
      service: {
        id: s.service_id!,
        name: names.get(s.service_id!) ?? s.service_id!,
      },
      deployment_id: s.deployment_id ?? null,
      at: s.at,
      conntrack: s.conntrack,
      connections,
      refused: s.refused,
      refused_truncated: s.refused_truncated,
      untrusted: {
        source: 'resolver answers' as const,
        names: Object.fromEntries(
          Object.entries(s.names).map(([address, name]) => [address, redact(name)]),
        ),
      },
    }
  })
}
