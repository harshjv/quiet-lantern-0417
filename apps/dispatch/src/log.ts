export type Log = (event: string, fields?: Record<string, unknown>) => void

const line = (event: string, fields: Record<string, unknown>) =>
  JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...fields,
  })

export const log: Log = (event, fields = {}) => console.log(line(event, fields))

export const logError: Log = (event, fields = {}) => console.error(line(event, fields))
