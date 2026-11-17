const brand = 'Stationly'

export const pageTitle = (...parts: string[]) =>
  [...parts.filter((part) => part.trim()), brand].join(' · ')

export const placeTitle = (project: string, preview: string | null) =>
  preview ? `${project}/${preview}` : `${project}/production`

export const titled = (...parts: string[]) => ({
  meta: [
    {
      title: pageTitle(...parts),
    },
  ],
})
