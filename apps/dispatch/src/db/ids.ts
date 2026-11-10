import { decodeTime, monotonicFactory } from 'ulid'

import { idPrefixes, type IdEntity } from '@stationly/protocol'

const ulid = monotonicFactory()

export const newId = (entity: IdEntity) => `${idPrefixes[entity]}_${ulid()}`

export const idTime = (id: string) => decodeTime(id.slice(id.indexOf('_') + 1))
