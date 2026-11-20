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
    name: 'previews',
    description: "A project's previews: copies of production's apps at their own URLs",
  },
  {
    name: 'apps',
    description: 'Apps in production or a preview',
  },
  {
    name: 'ports',
    description: 'Ports of an app',
  },
  {
    name: 'volumes',
    description: 'Volumes, their backups and restores',
  },
  {
    name: 'domains',
    description: 'Domains of an app',
  },
  {
    name: 'network',
    description: 'The network map, live connections, explanations, probes and DNS logs',
  },
  {
    name: 'deployments',
    description: 'Deployments, builds, redeploys and rollbacks of an app',
  },
  {
    name: 'runs',
    description: 'One-off runs of an app',
  },
  {
    name: 'machines',
    description: 'Persistent Linux machines for agents, isolated with gVisor',
  },
  {
    name: 'logs',
    description: 'Logs of an app, deployment, build, run, machine or platform component',
  },
  {
    name: 'metrics',
    description: 'Live metrics of apps',
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
    name: 'environment-variables',
    description: 'Environment variables, secret values and grants; secret values are never shown',
  },
  {
    name: 'approvals',
    description:
      'Changes to production that wait for a person: production, the platform and Ship it',
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
    name: 'servers',
    description: 'Servers',
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
