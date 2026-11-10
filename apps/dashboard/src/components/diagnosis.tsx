import { OctagonX, Wrench } from 'lucide-react'

import { AlsoWith, Code } from '@/components/code'
import { KeyValue } from '@/components/page'
import type { Diagnosis } from '@/lib/api'
import { tools, type Tool } from '@/lib/commands'
import { bytes, clock, json, shortSha } from '@/lib/format'
import { deploymentStep, diagnosisPhase, sentence } from '@/lib/labels'
import { endpointText } from '@/lib/network-layout'

const isTool = (name: string): name is Tool => (tools as readonly string[]).includes(name)

const stepName = (step: string) =>
  step in deploymentStep ? deploymentStep[step as keyof typeof deploymentStep] : sentence(step)

export function DiagnosisPanel({ diagnosis }: { diagnosis: Diagnosis }) {
  const diff = diagnosis.diff_from_last_good
  return (
    <div
      className="overflow-hidden rounded-lg border border-red-300 dark:border-red-900"
      data-testid="diagnosis"
    >
      <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/60">
        <OctagonX className="mt-0.5 size-4 shrink-0 text-red-700 dark:text-red-400" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-red-900 dark:text-red-100">
              Failed at {diagnosisPhase[diagnosis.phase].toLowerCase()}
            </h2>
          </div>
          <p className="text-sm text-red-900 dark:text-red-100">{diagnosis.summary}</p>
          <p className="font-mono text-xs text-red-900/70 dark:text-red-100/70">{diagnosis.code}</p>
        </div>
      </div>
      <div className="space-y-5 bg-card px-4 py-4">
        <KeyValue
          items={[
            ['Exit code', diagnosis.exit_code ?? 'none'],
            ['Out of memory', diagnosis.oom_killed ? 'Yes' : 'No'],
            [
              'Health check',
              diagnosis.health
                ? `${diagnosis.health.type.toUpperCase()}${diagnosis.health.path ? ` ${diagnosis.health.path}` : ''}${diagnosis.health.port ? ` on port ${diagnosis.health.port}` : ''} · ${sentence(diagnosis.health.result)}${diagnosis.health.attempts ? ` after ${diagnosis.health.attempts} tries` : ''}`
                : 'not run',
            ],
            [
              'Memory',
              diagnosis.resources
                ? `${bytes(diagnosis.resources.memory_peak_bytes)} peak of ${bytes(diagnosis.resources.memory_limit_bytes)}`
                : 'not measured',
            ],
            ...(diagnosis.network
              ? [
                  [
                    'Listening',
                    diagnosis.network.listening.length
                      ? diagnosis.network.listening.map(endpointText).join(', ')
                      : 'Nothing',
                  ] as [string, string],
                ]
              : []),
          ]}
        />
        {diagnosis.fixes && diagnosis.fixes.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              How to fix
            </h3>
            <ol className="space-y-2">
              {diagnosis.fixes.map((fix) => (
                <li key={fix.code} className="flex gap-3 rounded-md border px-3 py-2">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                    <p>{fix.text}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {fix.action &&
                        (isTool(fix.action.tool) ? (
                          <AlsoWith tool={fix.action.tool} className="justify-start" />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Your agent can run <Code className="text-xs">{fix.action.tool}</Code>
                          </span>
                        ))}
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {fix.code}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
        {diff && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Changed since the last good deployment
            </h3>
            <ul className="space-y-1 text-sm">
              {diff.source && (diff.source.from_sha || diff.source.to_sha) && (
                <li>
                  Source <Code>{shortSha(diff.source.from_sha) ?? 'none'}</Code> to{' '}
                  <Code>{shortSha(diff.source.to_sha) ?? 'none'}</Code>
                  {diff.source.files_changed != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {diff.source.files_changed} files
                    </span>
                  )}
                </li>
              )}
              {diff.variables?.map((v) => (
                <li key={v.key}>
                  Variable <Code>{v.key}</Code> from version {v.from_version ?? 'none'} to{' '}
                  {v.to_version ?? 'none'}
                </li>
              ))}
              {diff.config?.map((c) => (
                <li key={c.path}>
                  Setting <Code>{c.path}</Code> from{' '}
                  <Code className="text-muted-foreground">{json(c.from) || 'not set'}</Code> to{' '}
                  <Code>{json(c.to) || 'not set'}</Code>
                </li>
              ))}
              {diff.base_images?.map((b) => (
                <li key={b.ref}>
                  Base image <Code>{b.ref}</Code> has a newer version
                </li>
              ))}
              {!diff.source &&
                !diff.variables?.length &&
                !diff.config?.length &&
                !diff.base_images?.length && (
                  <li className="text-muted-foreground">
                    Nothing changed since deployment <Code>{diff.deployment_id}</Code>.
                  </li>
                )}
            </ul>
          </div>
        )}
        {diagnosis.logs && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Log lines{' '}
              <span className="normal-case">
                ({diagnosis.logs.untrusted.source}
                {diagnosis.logs.truncated ? ', cut short' : ''})
              </span>
            </h3>
            <pre
              className="max-h-72 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap dark:bg-zinc-950"
              tabIndex={0}
              aria-label="Log lines"
            >
              {diagnosis.logs.untrusted.text || 'The container wrote no log lines.'}
            </pre>
          </div>
        )}
        {diagnosis.events && diagnosis.events.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Timeline
            </h3>
            <ol className="flex flex-wrap gap-1.5 text-xs">
              {diagnosis.events.map((e, i) => (
                <li key={i} className="rounded border px-1.5 py-0.5">
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {clock(e.at)}
                  </span>{' '}
                  {stepName(e.step)} {sentence(e.status).toLowerCase()}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
