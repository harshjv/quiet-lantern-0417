import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useState, type RefObject } from 'react'

import { hasBecome, nextWatch, watching } from './moments'

gsap.registerPlugin(useGSAP)

export function useBecame(key: string, value: boolean | undefined) {
  const [watch, setWatch] = useState(() => watching(key, value))
  const next = nextWatch(watch, key, value)

  if (next !== watch) {
    setWatch(next)
  }

  return hasBecome(next, key, value)
}

export function useMoment(
  scope: RefObject<HTMLElement | null>,
  play: boolean,
  build: (timeline: gsap.core.Timeline) => gsap.core.Timeline,
) {
  useGSAP(
    () => {
      if (!play) {
        return
      }

      const media = gsap.matchMedia(scope)

      media.add('(prefers-reduced-motion: no-preference)', () => {
        build(
          gsap.timeline({
            defaults: {
              duration: 0.25,
              ease: 'power2.out',
            },
          }),
        )
      })

      return () => media.revert()
    },
    {
      scope,
      dependencies: [play],
    },
  )
}
