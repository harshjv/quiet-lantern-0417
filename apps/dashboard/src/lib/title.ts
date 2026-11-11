const brand = 'Stationly'

export const pageTitle = (...parts: string[]) =>
  [...parts.filter((part) => part.trim()), brand].join(' · ')

export const placeOf = (project: string, environment: string) => `${project}/${environment}`

export const titled = (...parts: string[]) => ({
  meta: [
    {
      title: pageTitle(...parts),
    },
  ],
})

export const loaderTitle = ({ loaderData }: { loaderData?: { title: string[] } }) =>
  titled(...(loaderData?.title ?? []))
