import { OctagonX, Wrench } from 'lucide-react'
import { KeyValue, Mono } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { bytes, clock, json, shortSha } from '@/lib/format'
import type { Diagnosis } from '@/lib/api'

export function DiagnosisPanel({ diagnosis }: { diagnosis: Diagnosis }) {
  const diff = diagnosis.diff_from_last_good
  return (
    <div className="overflow-hidden rounded-lg border border-red-300 dark:border-red-900" data-testid="diagnosis">
      <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/60">
        <OctagonX className="mt-0.5 size-4 shrink-0 text-red-700 dark:text-red-400" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-red-900 dark:text-red-100">Diagnosis</h2>
            <Badge variant="outline" className="font-mono">
              {diagnosis.code}
            </Badge>
            <Badge variant="outline">phase {diagnosis.phase}</Badge>
          </div>
          <p className="text-sm text-red-900 dark:text-red-100">{diagnosis.summary}</p>
        </div>
      </div>
      <div className="space-y-5 bg-card px-4 py-4">
        <KeyValue
          items={[
            ['Exit code', diagnosis.exit_code ?? '—'],
            ['Out of memory', diagnosis.oom_killed ? 'yes' : 'no'],
            ['Health', diagnosis.health ? `${diagnosis.health.type}${diagnosis.health.path ? ` ${diagnosis.health.path}` : ''}${diagnosis.health.port ? ` :${diagnosis.health.port}` : ''} · ${diagnosis.health.result}${diagnosis.health.attempts ? ` after ${diagnosis.health.attempts}` : ''}` : '—'],
            ['Memory', diagnosis.resources ? `${bytes(diagnosis.resources.memory_peak_bytes)} peak of ${bytes(diagnosis.resources.memory_limit_bytes)}` : '—'],
            ...(diagnosis.network ? [['Listening', diagnosis.network.listening.length ? diagnosis.network.listening.map(l => `${l.address}:${l.port}/${l.protocol}`).join(', ') : 'nothing'] as [string, string]] : [])
          ]}
        />
        {diagnosis.fixes && diagnosis.fixes.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Suggested fixes</h3>
            <ol className="space-y-2">
              {diagnosis.fixes.map(fix => (
                <li key={fix.code} className="flex gap-3 rounded-md border px-3 py-2">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 space-y-1 text-sm">
                    <p>
                      <Mono className="mr-2 text-xs text-muted-foreground">{fix.code}</Mono>
                      {fix.text}
                    </p>
                    {fix.action && (
                      <p className="text-xs text-muted-foreground">
                        Agents apply this with <Mono>{fix.action.tool}</Mono> <Mono>{JSON.stringify(fix.action.input)}</Mono>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
        {diff && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Changed since the last good deployment</h3>
            <ul className="space-y-1 text-sm">
              {diff.source && (diff.source.from_sha || diff.source.to_sha) && (
                <li>
                  source <Mono>{shortSha(diff.source.from_sha) ?? '—'}</Mono> → <Mono>{shortSha(diff.source.to_sha) ?? '—'}</Mono>
                  {diff.source.files_changed != null && <span className="text-muted-foreground"> · {diff.source.files_changed} files</span>}
                </li>
              )}
              {diff.variables?.map(v => (
                <li key={v.key}>
                  variable <Mono>{v.key}</Mono> v{v.from_version ?? '—'} → v{v.to_version ?? '—'}
                </li>
              ))}
              {diff.config?.map(c => (
                <li key={c.path}>
                  <Mono>{c.path}</Mono> <Mono className="text-muted-foreground">{json(c.from)}</Mono> → <Mono>{json(c.to)}</Mono>
                </li>
              ))}
              {diff.base_images?.map(b => (
                <li key={b.ref}>
                  base image <Mono>{b.ref}</Mono> moved
                </li>
              ))}
              {!diff.source && !diff.variables?.length && !diff.config?.length && !diff.base_images?.length && <li className="text-muted-foreground">Nothing changed; compared with {diff.deployment_id}.</li>}
            </ul>
          </div>
        )}
        {diagnosis.logs && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Relevant log lines <span className="normal-case">({diagnosis.logs.untrusted.source}{diagnosis.logs.truncated ? ', truncated' : ''})</span>
            </h3>
            <pre className="max-h-72 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap dark:bg-zinc-950" tabIndex={0} aria-label="Relevant log lines">
              {diagnosis.logs.untrusted.text || 'No lines were captured.'}
            </pre>
          </div>
        )}
        {diagnosis.events && diagnosis.events.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Steps</h3>
            <ol className="flex flex-wrap gap-1.5 text-xs">
              {diagnosis.events.map((e, i) => (
                <li key={i} className="rounded border px-1.5 py-0.5">
                  <Mono className="text-muted-foreground">{clock(e.at)}</Mono> {e.step} {e.status}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
