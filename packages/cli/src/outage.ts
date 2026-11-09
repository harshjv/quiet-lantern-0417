import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { isConnectionFailure } from './errors.ts'
import { progress } from './output.ts'

export const outageBudgetMs = 60_000
const firstDelayMs = 250
const maxDelayMs = 2_000

export const acrossOutage = async <T>(attempt: () => Promise<T>, deadline = Date.now() + outageBudgetMs): Promise<T> => {
  let delay = firstDelayMs
  let lost: number | null = null
  for (;;) {
    try {
      const result = await attempt()
      if (lost !== null) progress(`Dispatch is reachable again after ${((Date.now() - lost) / 1000).toFixed(1)} s`)
      return result
    } catch (error) {
      if (!isConnectionFailure(error) || Date.now() + delay >= deadline) throw error
      if (lost === null) {
        lost = Date.now()
        progress(`${(error as Error).message} Retrying until ${new Date(deadline).toISOString()}.`)
      }
      await sleep(delay)
      delay = Math.min(delay * 2, maxDelayMs)
    }
  }
}

export const acrossOutageOnce = <T>(attempt: (idempotencyKey: string) => Promise<T>, deadline?: number): Promise<T> => {
  const idempotencyKey = randomUUID()
  return acrossOutage(() => attempt(idempotencyKey), deadline)
}
