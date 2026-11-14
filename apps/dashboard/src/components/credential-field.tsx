import { Input } from '@/components/ui/input'

export function CredentialField({
  label,
  help,
  project,
  value,
  onChange,
}: {
  label: string
  help: string
  project: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1 px-1">
      <Input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={`${label} for ${project}`}
        autoComplete="off"
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  )
}
