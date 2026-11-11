const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

export const gibibyte = 1024 ** 3

export const bytesText = (value: number) => {
  let n = value
  let i = 0

  while (n >= 1024 && i < byteUnits.length - 1) {
    n /= 1024
    i += 1
  }

  return `${n >= 10 || i === 0 ? Math.round(n) : Number(n.toFixed(1))} ${byteUnits[i]}`
}

const secondsPer: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
}

export const parseDuration = (text: string) => {
  const compact = text.toLowerCase().replaceAll(/\s/g, '')

  if (!/^(\d+[smhd])+$/.test(compact)) {
    return null
  }

  return [...compact.matchAll(/(\d+)([smhd])/g)].reduce(
    (total, [, n, unit]) => total + Number(n) * secondsPer[unit!]!,
    0,
  )
}

export const parseSeconds = (text: string) =>
  /^\s*\d+\s*$/.test(text) ? Number(text) : parseDuration(text)

export const parseSize = (text: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*(?:([kmgt])(?:i?b)?|b)?$/i.exec(text.trim())

  if (!match) {
    return null
  }

  const power = match[2] ? 'kmgt'.indexOf(match[2].toLowerCase()) + 1 : 0

  return Math.round(Number(match[1]) * 1024 ** power)
}
