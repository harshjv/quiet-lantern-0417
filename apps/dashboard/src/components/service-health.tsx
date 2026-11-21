import { AlsoWith } from '@/components/code'
import { KeyValue } from '@/components/page'
import type { App } from '@/lib/api'
import { commands, type AppScope } from '@/lib/commands'
import { healthFacts, healthPortNote, healthWhy } from '@/lib/health-text'

export function AppHealth({ app, scope }: { app: App; scope: AppScope }) {
  const why = healthWhy(app)
  const note = healthPortNote(app.health, app.ports)
  const port = app.health && 'port' in app.health ? app.health.port : null

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">Health check</div>
        <KeyValue items={healthFacts(app.health)} />
        {why && <p className="text-xs text-muted-foreground">{why}</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {app.health && (
        <AlsoWith
          cli={commands.setHealth(scope, port)}
          tool="update_app"
          className="justify-start"
        />
      )}
    </div>
  )
}
