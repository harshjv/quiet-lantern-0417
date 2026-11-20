import type { IncomingMessage } from 'node:http'

import ipaddr from 'ipaddr.js'

export const clientAddressHeader = 'x-stationly-client-address'

const connectingIpHeader = 'cf-connecting-ip'

const normalized = (value: string | string[] | undefined) => {
  if (typeof value !== 'string' || !ipaddr.isValid(value.trim())) {
    return null
  }

  const parsed = ipaddr.parse(value.trim())

  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().toString()
    : parsed.toString()
}

export const clientAddress = (req: IncomingMessage, viaGateway: boolean) =>
  (viaGateway ? normalized(req.headers[connectingIpHeader]) : null) ??
  normalized(req.socket.remoteAddress)

export const stampClientAddress = (req: IncomingMessage, viaGateway: boolean) => {
  const address = clientAddress(req, viaGateway)
  const raw: string[] = []

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== clientAddressHeader) {
      raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
    }
  }

  delete req.headers[clientAddressHeader]

  if (address) {
    req.headers[clientAddressHeader] = address
    raw.push(clientAddressHeader, address)
  }

  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw)
}

export const clientAddressOf = (request: Request) =>
  request.headers.get(clientAddressHeader) ?? 'local'
