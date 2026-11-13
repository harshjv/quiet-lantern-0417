import { AlsoWith } from '@/components/code'
import type { Service } from '@/lib/api'
import { commands, type ServiceScope } from '@/lib/commands'
import { healthLine, healthPortNote, healthWhy } from '@/lib/health-text'

export function ServiceHealth({ service, scope }: { service: Service; scope: ServiceScope }) {
  const why = healthWhy(service)
  const note = healthPortNote(service.health, service.ports)
  const port = service.health && 'port' in service.health ? service.health.port : null

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground">Health check</div>
        <p className="text-sm">{healthLine(service.health)}</p>
        {why && <p className="text-xs text-muted-foreground">{why}</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {service.health && (
        <AlsoWith
          cli={commands.setHealth(scope, port)}
          tool="update_service"
          className="justify-start"
        />
      )}
    </div>
  )
}
