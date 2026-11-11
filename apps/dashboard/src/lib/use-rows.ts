import { useState } from 'react'

type Row<T> = T & { row: string }

const withRow = <T>(value: T): Row<T> => ({
  ...value,
  row: crypto.randomUUID(),
})

export function useRows<T extends object>(initial: T[], blank: () => T) {
  const [rows, setRows] = useState<Row<T>[]>(() => initial.map(withRow))

  return {
    rows,
    add: () => setRows((list) => [...list, withRow(blank())]),
    update: (row: string, patch: Partial<T>) =>
      setRows((list) =>
        list.map((r) =>
          r.row === row
            ? {
                ...r,
                ...patch,
              }
            : r,
        ),
      ),
    remove: (row: string) => setRows((list) => list.filter((r) => r.row !== row)),
  }
}
