import { workspaceSetupSteps, type WorkspaceSetupStep } from '@stationly/protocol'

import { repositoryName } from './format.ts'

const credentialsAsked =
  /could not read username|authentication failed|repository not found|terminal prompts disabled/i

export const failedStepText = (step: WorkspaceSetupStep | null) =>
  step ? `Failed at ${workspaceSetupSteps[step]}.` : 'Setup did not finish.'

export type SetupFailure = {
  title: string
  advice: string
  needsToken: boolean
}

export const setupFailure = (input: {
  step: WorkspaceSetupStep | null
  tail: readonly string[]
  repository: string
  branch: string | null
  project: string
}): SetupFailure => {
  const repository = repositoryName(input.repository)
  const next = 'Start a new task.'

  switch (input.step) {
    case 'clone':
      return input.tail.some((line) => credentialsAsked.test(line))
        ? {
            title: `Could not clone ${repository}.`,
            advice: `GitHub asked for credentials, so the repository is private or does not exist. Add a GitHub token to project ${input.project} and start a new task.`,
            needsToken: true,
          }
        : {
            title: `Could not clone ${repository}.`,
            advice: next,
            needsToken: false,
          }
    case 'checkout':
      return {
        title: `Could not check out ${input.branch ?? 'the branch'}.`,
        advice: next,
        needsToken: false,
      }
    case 'agent':
      return {
        title: 'Could not install the agent.',
        advice: next,
        needsToken: false,
      }
    case 'config':
      return {
        title: "Could not write the agent's configuration.",
        advice: next,
        needsToken: false,
      }
    case 'git_auth':
      return {
        title: 'Could not set up git sign-in.',
        advice: next,
        needsToken: false,
      }
    case 'toolchain':
      return {
        title: "Could not install the repository's toolchain.",
        advice: next,
        needsToken: false,
      }
    default:
      return {
        title: 'Setup did not finish.',
        advice: next,
        needsToken: false,
      }
  }
}
