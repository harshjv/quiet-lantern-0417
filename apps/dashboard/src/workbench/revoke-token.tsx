import { Confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { api, unwrap, type Token } from '@/lib/api'
import { done, useApiMutation } from '@/lib/mutation'
import { withoutToken } from '@/lib/queries'

export function RevokeToken({
  token,
  title,
  description,
  revoked,
}: {
  token: Token
  title: string
  description: string
  revoked: string
}) {
  const revoke = useApiMutation({
    mutationFn: async () =>
      done(
        await unwrap(
          api.v1
            .tokens({
              id: token.id,
            })
            .delete(),
        ),
      ),
    seed: () => withoutToken(token.id),
    success: () => revoked,
  })

  return (
    <Confirm
      title={title}
      description={description}
      action="Revoke token"
      cancel="Keep token"
      onConfirm={() => revoke.mutateAsync()}
      trigger={
        <Button variant="ghost" size="sm" aria-label={`Revoke ${token.name}`}>
          Revoke
        </Button>
      }
    />
  )
}
