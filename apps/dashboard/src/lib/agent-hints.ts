import { commands, scopeLabel, type AppScope, type Scope, type Tool } from './commands.ts'

export type Hint<S extends Scope> = {
  tools: readonly Tool[]
  prompt: (scope: S) => string
  command: (scope: S) => string
}

const place: Hint<Scope> = {
  tools: ['get_project', 'describe_preview', 'list_apps', 'create_app'],
  prompt: (scope) =>
    `Use Stationly to check ${scopeLabel(scope)}. List each app with its status and current deployment, and tell me which ones need attention.`,
  command: commands.listApps,
}

const app: Hint<AppScope> = {
  tools: ['describe_app', 'deploy', 'get_deployment_diagnosis', 'get_logs'],
  prompt: (scope) =>
    `Use Stationly to deploy the latest version of ${scope.app} in ${scopeLabel(scope)} and wait until it’s active. If it fails, read the diagnosis, fix the cause and deploy again.`,
  command: commands.deploy,
}

export const agentHints: { production: Hint<Scope>; preview: Hint<Scope>; app: Hint<AppScope> } = {
  production: place,
  preview: place,
  app,
}
