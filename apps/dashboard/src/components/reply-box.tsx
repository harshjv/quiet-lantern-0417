import { ArrowUp, Square } from 'lucide-react'
import { useState } from 'react'

import { modelLabel } from '@stationly/protocol'

import { StartSandbox } from '@/components/sandbox-actions'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, idempotency, unwrap, type AgentSession, type Sandbox } from '@/lib/api'
import { done, useApiMutation } from '@/lib/mutation'
import { isIdle } from '@/lib/status'

const own = (session: AgentSession) =>
  api.v1
    .sandboxes({
      sandbox: session.sandbox.id,
    })
    .agent.sessions({
      session: session.session_id,
    })

export function ReplyBox({
  session,
  sandbox,
  model,
}: {
  session: AgentSession
  sandbox: Sandbox | undefined
  model: string | null
}) {
  const [text, setText] = useState('')
  const reply = useApiMutation({
    mutationFn: async (value: string) =>
      done(
        await unwrap(
          own(session).prompts.post(
            {
              text: value,
            },
            idempotency(),
          ),
        ),
      ),
    invalidate: ['sandboxes'],
    failure: () => 'send the reply',
    onSuccess: () => setText(''),
  })
  const stop = useApiMutation({
    mutationFn: async () =>
      done(await unwrap(own(session).interrupt.post(undefined, idempotency()))),
    invalidate: ['sandboxes'],
    failure: () => 'stop the turn',
  })

  if (session.mode !== 'runner') {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Started in a terminal. Reply there.
      </p>
    )
  }

  const idle = sandbox ? isIdle(sandbox.status) : false
  const working = session.status === 'working' && session.setup === null
  const submit = () => {
    const value = text.trim()

    if (value && !reply.isPending && !idle) {
      reply.mutate(value)
    }
  }

  return (
    <div className="space-y-2 rounded-2xl border bg-card p-2">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Reply to continue on the same session…"
        aria-label="Reply to the agent"
        className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        disabled={idle}
      />
      <div className="flex items-center gap-2 px-1.5 pb-0.5 text-xs text-muted-foreground">
        <span className="truncate">
          {idle
            ? `${session.sandbox.name} is stopped.`
            : `Continues the same session in ${session.sandbox.name}.`}
          {model && ` ${modelLabel(model)}.`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {idle && sandbox && <StartSandbox sandbox={sandbox} />}
          {working ? (
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Stop the turn"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label="Send the reply"
              disabled={!text.trim() || reply.isPending || idle}
              onClick={submit}
            >
              <ArrowUp />
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
