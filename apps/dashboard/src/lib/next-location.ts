export const nextLocation = (target: string) => {
  const url = new URL(target, 'http://station.invalid')

  return {
    to: url.pathname,
    search: Object.fromEntries(url.searchParams),
  }
}
