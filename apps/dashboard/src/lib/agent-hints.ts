import { commands, type Scope, type ServiceScope, type Tool } from './commands.ts'

export type Hint<S extends Scope> = {
  tools: readonly Tool[]
  prompt: (scope: S) => string
  command: (scope: S) => string
}

const environment: Hint<Scope> = {
  tools: ['describe_environment', 'list_services', 'create_service'],
  prompt: ({ project, environment }) =>
    `Use Stationly to check ${project}/${environment}. List each service with its status and current deployment, and tell me which ones need attention.`,
  command: commands.listServices,
}

const service: Hint<ServiceScope> = {
  tools: ['describe_service', 'deploy', 'get_deployment_diagnosis', 'get_logs'],
  prompt: ({ project, environment, service }) =>
    `Use Stationly to deploy the latest version of ${service} in ${project}/${environment} and wait until it’s active. If it fails, read the diagnosis, fix the cause and deploy again.`,
  command: commands.deploy,
}

export const agentHints = {
  '/_app/projects/$project/$environment': environment,
  '/_app/services/$service': service,
}
