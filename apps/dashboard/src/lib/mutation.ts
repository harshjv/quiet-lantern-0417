import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { failureText } from './api'
import { applyOptimistic, rollback, write, type Edit } from './cache'
import { toastFailure } from './failure'
import { invalidateGroups, type Group } from './invalidate'
import { toastStaged } from './staged'

export type Message = string | { title: string; description?: string }

type Outcome = { staged: false; body: unknown } | { staged: true; body: { id: string } }

type Body<R> = R extends { staged: false; body: infer B } ? B : never

type Warning = { code: string; explanation: string; fix?: string }

export const done = <B>(body: B) => ({
  staged: false as const,
  body,
})

const toastWarnings = (body: unknown) => {
  const warnings =
    body && typeof body === 'object' && 'warnings' in body && Array.isArray(body.warnings)
      ? (body.warnings as Warning[])
      : []

  for (const warning of warnings) {
    toast.warning(warning.explanation, {
      description: warning.fix,
    })
  }
}

const split = (message: Message) =>
  typeof message === 'string'
    ? {
        title: message,
      }
    : message

export function useApiMutation<V = void, R extends Outcome = Outcome>(options: {
  mutationFn: (vars: V) => Promise<R>
  optimistic?: (vars: V) => Edit[]
  seed?: (body: Body<R>, vars: V) => Edit[]
  invalidate?: Group[]
  staged?: (vars: V) => string
  success?: (body: Body<R>, vars: V) => Message | void
  onSuccess?: (result: R, vars: V) => void
  failure?: (vars: V) => string
  intercept?: (failure: unknown, vars: V) => boolean
}) {
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: options.mutationFn,
    onMutate: (vars, { client }) =>
      options.optimistic ? applyOptimistic(client, options.optimistic(vars)) : undefined,
    onSuccess: (result, vars, snapshot, { client }) => {
      if (result.staged) {
        if (snapshot) {
          rollback(client, snapshot)
        }

        toastStaged(navigate, result.body.id, options.staged?.(vars))
      } else {
        write(client, options.seed?.(result.body as Body<R>, vars) ?? [])
        const message = options.success?.(result.body as Body<R>, vars)

        if (message) {
          const { title, description } = split(message)

          toast.success(title, {
            description,
          })
        }

        toastWarnings(result.body)
      }

      options.onSuccess?.(result, vars)
    },
    onError: (failure, vars, snapshot, { client }) => {
      if (snapshot) {
        rollback(client, snapshot)
      }

      if (options.intercept?.(failure, vars)) {
        return
      }

      if (options.failure) {
        toastFailure(options.failure(vars), failure)
      }
    },
    onSettled: (result, _failure, _vars, _snapshot, { client }) =>
      invalidateGroups(client, [
        ...(options.invalidate ?? []),
        ...(result?.staged ? (['staged'] as const) : []),
      ]),
  })

  return {
    ...mutation,
    errorText: mutation.error && !options.failure ? failureText(mutation.error) : null,
  }
}
