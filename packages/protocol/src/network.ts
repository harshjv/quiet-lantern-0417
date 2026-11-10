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
  dispatchPort: 7900
} as const
