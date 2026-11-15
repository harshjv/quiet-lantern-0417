import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

const px = 5

const train = [
  '..55555555..',
  '.5511551155.',
  '.5511551155.',
  '.5555555555.',
  '555555555555',
  '.66.66..66.6',
]

const platform = [
  '444444444444444444',
  '.55555555555555555',
  '..5............5..',
  '..5............5..',
  '..5............5..',
  '..5............5..',
  '..5............5..',
  '333333333333333333',
  '222222222222222222',
]

const cloud = ['...222...', '.2222222.', '222222222']

const signal = ['44', '66', '.6', '.6', '.6', '.6', '.6', '.6']

const tree = ['..3..', '.333.', '33333', '.333.', '..4..']

const puff = ['.22.', '2222', '.22.']

type Props = {
  slots: number
  running: number
  queued: number
  live?: boolean
  className?: string
}

const tokens = () => {
  const cs = getComputedStyle(document.documentElement)

  return Object.fromEntries(
    ['1', '2', '3', '4', '5', '6'].map((k) => [k, cs.getPropertyValue(`--brand-${k}`).trim()]),
  )
}

export function PixelScene({ slots, running, queued, live = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current

    if (!canvas) {
      return
    }

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let raf = 0

    const draw = () => {
      const w = Math.floor(canvas.clientWidth / px)
      const h = Math.floor(canvas.clientHeight / px)

      canvas.width = w * px
      canvas.height = h * px

      const ctx = canvas.getContext('2d')!
      const c = tokens()
      const cell = (x: number, y: number, k: string) => {
        if (k === '.') {
          return
        }

        ctx.fillStyle = c[k]!
        ctx.fillRect(x * px, y * px, px, px)
      }
      const sprite = (rows: string[], x: number, y: number) =>
        rows.forEach((row, j) => row.split('').forEach((k, i) => cell(x + i, y + j, k)))

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const band = y / h
          const dither = (x + y) % 2 === 0

          cell(
            x,
            y,
            band < 0.35
              ? '1'
              : band < 0.55
                ? dither
                  ? '1'
                  : '2'
                : band < 0.7
                  ? '2'
                  : dither
                    ? '2'
                    : '3',
          )
        }
      }

      for (let k = 0; k < 4; k++) {
        const cx = (Math.floor((k * w) / 4 + (still ? 0 : frame / 4)) % (w + 9)) - 9

        sprite(cloud, cx, 2 + ((k * 5) % 7))
      }

      for (let x = 2; x < w; x += 9) {
        sprite(tree, x, Math.floor(h * 0.55) - 4 + ((x * 7) % 3))
      }

      const rail = h - 6

      for (let x = 0; x < w; x++) {
        cell(x, rail, '6')
        cell(x, rail + 3, '6')

        if (x % 4 === 0) {
          cell(x, rail + 1, '4')
          cell(x, rail + 2, '4')
        }
      }

      const gap = 22
      const left = Math.max(18, Math.floor((w - slots * gap) / 2))

      for (let s = 0; s < slots; s++) {
        const x = left + s * gap

        sprite(platform, x - 2, rail - 9)

        if (s < running) {
          const bob = still ? 0 : Math.floor((frame / 12 + s) % 2)

          sprite(train, x + 2, rail - 6 - bob)

          if (!still) {
            sprite(
              puff,
              x + 4 + ((frame / 6 + s * 3) % 6),
              rail - 11 - Math.floor(((frame / 6 + s * 3) % 6) / 2),
            )
          }
        }
      }

      for (let q = 0; q < queued; q++) {
        sprite(train, 2 + q * 13, rail - 6)
      }

      if (live) {
        sprite(signal, w - 6, rail - 8)
      }
    }

    const loop = () => {
      draw()
      frame += 1
      raf = window.setTimeout(loop, 140)
    }

    if (still) {
      draw()
    } else {
      loop()
    }

    const observer = new ResizeObserver(() => draw())

    observer.observe(canvas)

    const themes = new MutationObserver(() => draw())

    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      clearTimeout(raf)
      observer.disconnect()
      themes.disconnect()
    }
  }, [slots, running, queued, live])

  return (
    <canvas
      ref={ref}
      className={cn('block w-full [image-rendering:pixelated]', className)}
      aria-hidden
    />
  )
}
