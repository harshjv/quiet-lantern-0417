export const operationTags = [
  {
    name: 'identity',
    description: 'The caller',
  },
  {
    name: 'projects',
    description: 'Projects',
  },
  {
    name: 'environments',
    description: 'Environments of a project',
  },
  {
    name: 'services',
    description: 'Services of an environment',
  },
  {
    name: 'ports',
    description: 'Ports of a service',
  },
  {
    name: 'volumes',
    description: 'Volumes, their backups and restores',
  },
  {
    name: 'domains',
    description: 'Domains and TCP exposures of a service',
  },
  {
    name: 'network',
    description: 'The network map, live connections, explanations, probes and DNS logs',
  },
  {
    name: 'deployments',
    description: 'Deployments, builds, redeploys and rollbacks of a service',
  },
  {
    name: 'runs',
    description: 'One-off runs of a service',
  },
  {
    name: 'sandboxes',
    description: 'Persistent Linux machines for agents, isolated with gVisor',
  },
  {
    name: 'logs',
    description: 'Logs of a service, deployment, build, run, sandbox or platform component',
  },
  {
    name: 'metrics',
    description: 'Live metrics of services',
  },
  {
    name: 'events',
    description: 'Events visible to the caller',
  },
  {
    name: 'notifications',
    description: 'Notification channels',
  },
  {
    name: 'variables',
    description: 'Variables, secret values and grants; sealed values are never shown',
  },
  {
    name: 'staged-changes',
    description: 'Changes that wait for a human in a protected environment or platform',
  },
  {
    name: 'settings',
    description: 'Instance settings',
  },
  {
    name: 'tokens',
    description: 'Personal and scoped tokens',
  },
  {
    name: 'stations',
    description: 'Stations',
  },
  {
    name: 'platform',
    description: 'Lockfile, signatures, inventory, health and releases',
  },
  {
    name: 'audit',
    description: 'The audit trail',
  },
  {
    name: 'manifest',
    description: 'The Manifest: stationly.yaml',
  },
  {
    name: 'github',
    description: 'The GitHub App connection',
  },
]
