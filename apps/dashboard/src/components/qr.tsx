import { useMemo } from 'react'
import { encode } from 'uqr'

export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const { path, cells } = useMemo(() => {
    const qr = encode(value, { border: 2, ecc: 'M' })
    const parts: string[] = []
    qr.data.forEach((row, y) => row.forEach((on, x) => on && parts.push(`M${x} ${y}h1v1h-1z`)))
    return { path: parts.join(''), cells: qr.size }
  }, [value])
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${cells} ${cells}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-md bg-white">
      <path d={path} fill="#000" />
    </svg>
  )
}
