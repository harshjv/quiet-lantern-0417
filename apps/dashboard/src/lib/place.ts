export type Place = { project: string; preview: string | null }

export const productionOf = (project: string): Place => ({
  project,
  preview: null,
})

export const placeOf = (row: { project_id: string; preview_id: string | null }): Place => ({
  project: row.project_id,
  preview: row.preview_id,
})

export const placeKey = (place: Place) => place.preview ?? place.project

export const previewQuery = (place: Place) =>
  place.preview
    ? {
        preview: place.preview,
      }
    : {}

export const isProduction = (place: Place) => place.preview === null

export type PlaceView = Place & { projectName: string; previewName: string | null }

export const placeName = (place: PlaceView) => place.previewName ?? 'production'

export const scopeOf = (place: PlaceView) => ({
  project: place.projectName,
  preview: place.previewName,
})
