import { OctagonX } from 'lucide-react'

import { Code, Output } from '@/components/code'
import { Disclosure } from '@/components/disclosure'
import { FixList } from '@/components/fix'
import { Name } from '@/components/name'
import { KeyValue } from '@/components/page'
import type { Diagnosis } from '@/lib/api'
import type { FixContext } from '@/lib/fixes'
import { bytes, clock, json, plural, shortSha } from '@/lib/format'
import { deploymentStep, diagnosisFailed, diagnosisPhase, sentence } from '@/lib/labels'
import { endpointText } from '@/lib/network-text'
import { tonePanel } from '@/lib/tone'
import { cn } from '@/lib/utils'

const stepName = (step: string) =>
  step in deploymentStep ? deploymentStep[step as keyof typeof deploymentStep] : sentence(step)

const healthText = (health: NonNullable<Diagnosis['health']>) =>
  [health.type.toUpperCase(), health.path, health.port ? `on port ${health.port}` : null]
    .filter(Boolean)
    .join(' ')

const healthResult = (health: NonNullable<Diagnosis['health']>) =>
  [sentence(health.result), health.attempts ? `after ${health.attempts} tries` : null]
    .filter(Boolean)
    .join(' ')

type Fact = [string, string | null]

const known = (fact: Fact): fact is [string, string] => fact[1] !== null

const facts = (diagnosis: Diagnosis) =>
  (
    [
      ['Failed at', diagnosisPhase[diagnosis.phase]],
      ['Exit code', diagnosis.exit_code == null ? null : String(diagnosis.exit_code)],
      ['Out of memory', diagnosis.oom_killed ? 'Yes' : null],
      [
        'Memory',
        diagnosis.resources
          ? `${bytes(diagnosis.resources.memory_peak_bytes)} peak of ${bytes(diagnosis.resources.memory_limit_bytes)}`
          : null,
      ],
      ['Health check', diagnosis.health ? healthText(diagnosis.health) : null],
      ['Health result', diagnosis.health ? healthResult(diagnosis.health) : null],
      [
        'Listening on',
        diagnosis.network
          ? diagnosis.network.listening.map(endpointText).join(', ') || 'nothing'
          : null,
      ],
      ['Code', diagnosis.code],
    ] satisfies Fact[]
  ).filter(known)

function Changes({ diff }: { diff: NonNullable<Diagnosis['diff_from_last_good']> }) {
  return (
    <ul className="space-y-1 text-sm">
      {diff.source && (diff.source.from_sha || diff.source.to_sha) && (
        <li>
          Source <Code>{shortSha(diff.source.from_sha) ?? 'none'}</Code> to{' '}
          <Code>{shortSha(diff.source.to_sha) ?? 'none'}</Code>
          {diff.source.files_changed != null && diff.source.files_changed > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              {plural(diff.source.files_changed, 'file')}
            </span>
          )}
        </li>
      )}
      {diff.environment_variables?.map((v) => (
        <li key={v.name}>
          Environment variable <Code>{v.name}</Code> from version {v.from_version ?? 'none'} to{' '}
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
        !diff.environment_variables?.length &&
        !diff.config?.length &&
        !diff.base_images?.length && (
          <li className="text-muted-foreground">
            Nothing changed since deployment <Code>{diff.deployment_id}</Code>.
          </li>
        )}
    </ul>
  )
}

const changeCount = (diff: NonNullable<Diagnosis['diff_from_last_good']>) =>
  (diff.source ? 1 : 0) +
  (diff.environment_variables?.length ?? 0) +
  (diff.config?.length ?? 0) +
  (diff.base_images?.length ?? 0)

export function DiagnosisPanel({
  diagnosis,
  context,
}: {
  diagnosis: Diagnosis
  context: FixContext
}) {
  const diff = diagnosis.diff_from_last_good
  const fixes = diagnosis.fixes ?? []
  const details = facts(diagnosis)
  const changes = diff ? changeCount(diff) : 0

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="diagnosis">
      <div className={cn('flex items-start gap-3 border-0 border-b px-4 py-3', tonePanel.danger)}>
        <OctagonX className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">
            <Name kind="app">{context.subject.name}</Name> {diagnosisFailed[diagnosis.phase]}
          </h2>
          <p className="text-sm">{diagnosis.summary}</p>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        <FixList fixes={fixes} context={context} />
        <Disclosure title="Details">
          <div className="space-y-4">
            <KeyValue items={details} />
            {diagnosis.events && diagnosis.events.length > 0 && (
              <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Timeline">
                {diagnosis.events.map((e, i) => (
                  <li key={i} className="rounded border px-1.5 py-0.5">
                    <span className="text-muted-foreground tabular-nums">{clock(e.at)}</span>{' '}
                    {stepName(e.step)} {sentence(e.status).toLowerCase()}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Disclosure>
        {diff && (
          <Disclosure
            title="What changed since the last good deployment"
            summary={changes ? plural(changes, 'change') : 'nothing'}
          >
            <Changes diff={diff} />
          </Disclosure>
        )}
        {diagnosis.logs && (
          <Disclosure
            title="Last log lines"
            summary={`${diagnosis.logs.untrusted.source}${diagnosis.logs.truncated ? ', cut short' : ''}`}
            defaultOpen={fixes.length === 0}
          >
            <Output tabIndex={0} aria-label="Log lines">
              {diagnosis.logs.untrusted.text || 'The container wrote no log lines.'}
            </Output>
          </Disclosure>
        )}
      </div>
    </div>
  )
}
