export const networkLayout = {
  defaultPool: '10.200.0.0/16',
  defaultVirtualPrefix: '100.64.0.0/16',
  systemIndex: 0,
  ingressIndex: 1,
  registryFirstIndex: 3,
  firstEnvironmentIndex: 16,
  gatewayHost: 1,
  registryHost: 2,
  registryPort: 5000,
  dispatchHost: 2,
  dispatchVirtualHost: 1,
  firstServiceVirtualHost: 2,
  dispatchHostAddress: '127.0.0.1',
  dispatchPort: 7900,
} as const

export const networkAddress = (pool: string, slash24Index: number, host: number) => {
  const base = pool
    .split('/')[0]!
    .split('.')
    .reduce((value, octet) => value * 256 + Number(octet), 0)
  const value = base + slash24Index * 256 + host

  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.')
}

export const dispatchAddress =
  `${networkLayout.dispatchHostAddress}:${networkLayout.dispatchPort}` as const

export const defaultRegistryAddress = `${networkAddress(networkLayout.defaultPool, networkLayout.registryFirstIndex, networkLayout.registryHost)}:${networkLayout.registryPort}`
