import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'

export function AgentMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'min-w-0 text-sm break-words [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.8125rem] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_ul]:list-disc [&_ul]:pl-5',
        className,
      )}
    >
      {renderMarkdown(text)}
    </div>
  )
}
