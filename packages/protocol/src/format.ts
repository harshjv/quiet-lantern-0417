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
