import type { AnchorHTMLAttributes } from 'react'

import { nextPlace, placeHref, usePlace, type Place } from '@/lib/nav'

export function PlaceLink({
  to,
  children,
  ...props
}: { to: Partial<Place> } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...props} href={placeHref(nextPlace(usePlace(), to))}>
      {children}
    </a>
  )
}
