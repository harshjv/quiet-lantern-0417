import { Link } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

export type Crumb = { label: ReactNode; to?: string; params?: Record<string, string> }

export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <Breadcrumb className="mb-3">
      <BreadcrumbList>
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {item.to && i < items.length - 1 ? (
                <BreadcrumbLink asChild>
                  <Link to={item.to} params={item.params}>
                    {item.label}
                  </Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{item.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
