import type { ComponentProps, ReactNode } from 'react'
import { Table, TableCell, TableHead, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export function TableFrame({ caption, className, children, ...props }: ComponentProps<'div'> & { caption?: ReactNode }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border', className)} {...props}>
      <Table>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </Table>
    </div>
  )
}

export function ActionsHead({ className }: { className?: string }) {
  return (
    <TableHead className={cn('text-right', className)}>
      <span className="sr-only">Actions</span>
    </TableHead>
  )
}

export function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}
