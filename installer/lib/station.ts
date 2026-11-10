import { writeFileSync } from 'node:fs'

import {
  defaultRegistryAddress,
  dispatchAddress,
  networkLayout,
} from '../../packages/protocol/src/network.ts'
import {
  nftTableName,
  nftTablePrefix,
  recoveryKeyPrefix,
  resourcePrefix,
  tokenPrefix,
} from '../../packages/protocol/src/primitives.ts'
import { rootSocketPath, stationdUnit } from '../../packages/protocol/src/root-socket.ts'

const constants = {
  RESOURCE_PREFIX: resourcePrefix,
  NFT_TABLE_NAME: nftTableName,
  NFT_TABLE_PREFIX: nftTablePrefix,
  RECOVERY_KEY_PREFIX: recoveryKeyPrefix,
  TOKEN_PREFIX: tokenPrefix,
  STATIOND_UNIT: stationdUnit,
  ROOT_SOCKET_PATH: rootSocketPath,
  DISPATCH_PORT: networkLayout.dispatchPort,
  DISPATCH_ADDRESS: dispatchAddress,
  DEFAULT_POOL: networkLayout.defaultPool,
  REGISTRY_PORT: networkLayout.registryPort,
  REGISTRY_ADDRESS: defaultRegistryAddress,
}

const line = ([name, value]: [string, string | number]) => {
  if (String(value).includes("'")) throw new Error(`${name} holds a single quote`)
  return `${name}='${value}'`
}

writeFileSync(
  new URL('station.gen.sh', import.meta.url),
  `${Object.entries(constants).map(line).join('\n')}\n`,
)
