import { Check, CircleAlert, Loader2 } from 'lucide-react'

import { Code } from '@/components/code'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { AgentSession } from '@/lib/api'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Setup = NonNullable<AgentSession['setup']>

export const setupSteps = [
  'Workspace created',
  'Starting the machine',
  'Cloning and setting up',
  'Starting the agent',
]

export const activeStep = (state: Setup['state']) =>
  state === 'creating' ? 1 : state === 'setting_up' ? 2 : 3

export function TaskSetup({ setup }: { setup: Setup }) {
  const active = activeStep(setup.state)
  const failed = setup.state === 'failed'

  return (
    <div className="space-y-3">
      <ol className="space-y-2" aria-label="Setting up the workspace">
        {setupSteps.map((step, index) => {
          const done = index < active
          const current = index === active && !failed

          return (
            <li key={step} className="flex items-center gap-2.5 text-sm">
              {done ? (
                <Check className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
              ) : current ? (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden
                />
              ) : index === active && failed ? (
                <CircleAlert className={cn('size-4', toneText.danger)} aria-hidden />
              ) : (
                <span className="size-4 rounded-full border border-dashed" aria-hidden />
              )}
              <span className={cn(!done && !current && 'text-muted-foreground')}>{step}</span>
              <span className="sr-only">{done ? ', done' : current ? ', in progress' : ''}</span>
            </li>
          )
        })}
      </ol>
      {failed && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="space-y-1">
            <p>The workspace did not get ready, so the agent never started.</p>
            {setup.run_id && (
              <p>
                Read why with{' '}
                <Code copy={`sly runs get ${setup.run_id}`}>{`sly runs get ${setup.run_id}`}</Code>
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
