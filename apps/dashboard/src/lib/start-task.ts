import { api, ApiFailure, idempotency, send, unwrap } from './api'
import { taskName } from './new-task'

const nameRetries = 3

export const storeProjectKey = (
  scope: { project: string; environment: string },
  key: string,
  value: string,
) =>
  send(
    api.v1
      .projects({
        project: scope.project,
      })
      .variables.patch(
        {
          environment: scope.environment,
          set: [
            {
              key,
              kind: 'sealed',
              value: value.trim(),
            },
          ],
        },
        idempotency(),
      ),
  )

const createWorkspace = async (input: {
  environment: string
  agent: 'claude' | 'codex'
  repository: string
  prompt: string
  memory: number
}) => {
  for (let attempt = 0; ; attempt += 1) {
    const made = await api.v1
      .environments({
        environment: input.environment,
      })
      .sandboxes.post(
        {
          name: taskName(input.prompt),
          size: {
            memory_bytes: input.memory,
          },
          workspace: {
            agent: input.agent,
            repository: input.repository,
            level: 'read',
          },
        },
        idempotency(),
      )

    if (made.error) {
      const failure = (made.error.value as { error: { code?: string } }).error

      if (failure.code === 'NAME_TAKEN' && attempt < nameRetries) {
        continue
      }

      throw new ApiFailure(made.status, failure)
    }

    if (made.status === 202) {
      throw new Error(
        'This environment is protected, so creating the workspace waits for your review.',
      )
    }

    return (made.data as { id: string }).id
  }
}

export const startTask = async (input: {
  environment: string
  agent: 'claude' | 'codex'
  repository: string
  prompt: string
  model: string
  memory: number
  workspace?: string
}) =>
  unwrap(
    api.v1['agent-sessions'].post(
      {
        workspace: input.workspace ?? (await createWorkspace(input)),
        prompt: input.prompt,
        model: input.model,
      },
      idempotency(),
    ),
  )
