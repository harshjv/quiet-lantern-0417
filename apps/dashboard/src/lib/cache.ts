import type { QueryClient, QueryKey, QueryKeyWithDataTag } from '@tanstack/react-query'

export type Edit = { queryKey: QueryKey; apply: (client: QueryClient) => void }

export type Snapshot = { queryKey: QueryKey; data: unknown }[]

type Page<T> = { items: T[] }

export const on = <T>(
  options: QueryKeyWithDataTag<QueryKey, T>,
  update: (cached: T | undefined) => T | undefined,
): Edit => ({
  queryKey: options.queryKey,
  apply: (client) => client.setQueryData(options.queryKey, update),
})

export const editItems = <T>(
  options: QueryKeyWithDataTag<QueryKey, Page<T>>,
  update: (items: T[]) => T[],
): Edit =>
  on(
    options,
    (page) =>
      page && {
        ...page,
        items: update(page.items),
      },
  )

export const seed = <T extends object>(
  options: QueryKeyWithDataTag<QueryKey, T>,
  data: NoInfer<T>,
): Edit =>
  on(options, (cached) =>
    cached
      ? {
          ...cached,
          ...data,
        }
      : data,
  )

export const merge = <T extends object>(
  options: QueryKeyWithDataTag<QueryKey, T>,
  data: NoInfer<Partial<T>>,
): Edit =>
  on(
    options,
    (cached) =>
      cached && {
        ...cached,
        ...data,
      },
  )

export const mergeItem = <T extends { id: string }>(
  options: QueryKeyWithDataTag<QueryKey, Page<T>>,
  id: string,
  data: NoInfer<Partial<T>>,
): Edit =>
  editItems(options, (list) =>
    list.map((item) =>
      item.id === id
        ? {
            ...item,
            ...data,
          }
        : item,
    ),
  )

export const seedItem = <T extends { id: string }>(
  options: QueryKeyWithDataTag<QueryKey, Page<T>>,
  item: NoInfer<T>,
): Edit =>
  editItems(options, (list) =>
    list.some((cached) => cached.id === item.id)
      ? list.map((cached) =>
          cached.id === item.id
            ? {
                ...cached,
                ...item,
              }
            : cached,
        )
      : [...list, item],
  )

export const prependItem = <T>(
  options: QueryKeyWithDataTag<QueryKey, Page<T>>,
  item: (list: T[]) => T,
): Edit => editItems(options, (list) => [item(list), ...list])

export const optimistic = <T extends object>(row: T): T => ({
  ...row,
  optimistic: true,
})

export const isOptimistic = (row: object) => 'optimistic' in row

export const write = (client: QueryClient, edits: Edit[]) => {
  for (const edit of edits) {
    edit.apply(client)
  }
}

export const applyOptimistic = async (client: QueryClient, edits: Edit[]): Promise<Snapshot> => {
  await Promise.all(
    edits.map((edit) =>
      client.cancelQueries({
        queryKey: edit.queryKey,
        exact: true,
      }),
    ),
  )
  const snapshot = edits.map((edit) => ({
    queryKey: edit.queryKey,
    data: client.getQueryData(edit.queryKey),
  }))

  write(client, edits)

  return snapshot
}

export const rollback = (client: QueryClient, snapshot: Snapshot) => {
  for (const { queryKey, data } of snapshot) {
    client.setQueryData(queryKey, data)
  }
}
