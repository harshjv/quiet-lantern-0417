import { Resolver } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

import { Agent, setGlobalDispatcher } from 'undici'

export const stationLookup = (address: string): LookupFunction => {
  const resolver = new Resolver({
    timeout: 2000,
    tries: 2,
  })
  resolver.setServers([address])
  return (hostname, options, callback) => {
    const all = Boolean((options as { all?: boolean }).all)
    const reply = (addresses: string[]) => {
      const family = isIP(addresses[0]!)
      if (all)
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null,
          addresses.map((a) => ({
            address: a,
            family: isIP(a),
          })),
        )
      else callback(null, addresses[0]!, family)
    }
    if (isIP(hostname)) return reply([hostname])
    resolver.resolve4(hostname, (error, addresses) => {
      if (error) return callback(error, '', 4)
      if (!addresses.length)
        return callback(
          Object.assign(new Error(`${hostname} has no A record`), {
            code: 'ENODATA',
          }),
          '',
          4,
        )
      reply(addresses)
    })
  }
}

export const routeFetchThroughStation = (address: string | null) => {
  if (!address) return false
  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup: stationLookup(address),
      },
    }),
  )
  return true
}
