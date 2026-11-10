import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { failureText } from './api'
import { useInvalidate, type Group } from './invalidate'
import { toastStaged } from './staged'

export type Message = string | { title: string; description?: string }

type Outcome = { staged: false; body: unknown } | { staged: true; body: { id: string } }

type Body<R> = R extends { staged: false; body: infer B } ? B : never

type Warning = { code: string; explanation: string }

export const done = <B>(body: B) => ({ staged: false as const, body })

const toastWarnings = (body: unknown) => {
  const warnings = body && typeof body === 'object' && 'warnings' in body && Array.isArray(body.warnings) ? (body.warnings as Warning[]) : []
  for (const warning of warnings) toast.warning(warning.code, { description: warning.explanation })
}

const split = (message: Message) => (typeof message === 'string' ? { title: message } : message)

export function useApiMutation<V = void, R extends Outcome = Outcome>(options: {
  mutationFn: (vars: V) => Promise<R>
  invalidate?: Group[]
  staged?: (vars: V) => Message
  success?: (body: Body<R>, vars: V) => Message | void
  onSuccess?: (result: R, vars: V) => void
  failure?: (vars: V) => string
  intercept?: (failure: unknown, vars: V) => boolean
}) {
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const mutation = useMutation({
    mutationFn: options.mutationFn,
    onSuccess: (result, vars) => {
      invalidate(...(options.invalidate ?? []), ...(result.staged ? (['staged'] as const) : []))
      if (result.staged) {
        const message = split(options.staged?.(vars) ?? 'The change was staged for review')
        toastStaged(navigate, message.title, result.body.id, message.description)
      } else {
        const message = options.success?.(result.body as Body<R>, vars)
        if (message) {
          const { title, description } = split(message)
          toast.success(title, { description })
        }
        toastWarnings(result.body)
      }
      options.onSuccess?.(result, vars)
    },
    onError: (failure, vars) => {
      if (options.intercept?.(failure, vars)) return
      if (options.failure) toast.error(options.failure(vars), { description: failureText(failure) })
    }
  })
  return { ...mutation, errorText: mutation.error && !options.failure ? failureText(mutation.error) : null }
}
