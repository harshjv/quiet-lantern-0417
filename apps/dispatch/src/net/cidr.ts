import ipaddr from 'ipaddr.js'

import { networkLayout } from '@stationly/protocol'

export type Cidr = { address: ipaddr.IPv4; bits: number }

const toNumber = (address: ipaddr.IPv4) =>
  address.toByteArray().reduce((value, octet) => value * 256 + octet, 0)

const fromNumber = (value: number) =>
  new ipaddr.IPv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])

const readCidr = (text: string): Cidr | null => {
  const [address, bits, ...rest] = text.split('/')

  if (
    rest.length ||
    !address ||
    !bits ||
    !/^\d{1,2}$/.test(bits) ||
    Number(bits) > 32 ||
    !ipaddr.IPv4.isValidFourPartDecimal(address)
  ) {
    return null
  }

  return {
    address: ipaddr.IPv4.parse(address),
    bits: Number(bits),
  }
}

const networkOf = (cidr: Cidr) =>
  ipaddr.IPv4.networkAddressFromCIDR(`${cidr.address.toString()}/${cidr.bits}`)

export const cidrProblem = (text: string) => {
  const cidr = readCidr(text)

  if (!cidr) {
    return `${text} is not an IPv4 CIDR`
  }

  const network = networkOf(cidr)

  return network.toString() === cidr.address.toString()
    ? null
    : `${text} has host bits set; use ${network.toString()}/${cidr.bits}`
}

export const parseCidr = (text: string): Cidr | null =>
  cidrProblem(text) === null ? readCidr(text) : null

const mustParse = (text: string) => {
  const cidr = parseCidr(text)

  if (!cidr) {
    throw new Error(`${text} is not an IPv4 CIDR`)
  }

  return cidr
}

export const contains = (outer: Cidr, inner: Cidr) =>
  inner.bits >= outer.bits && inner.address.match(outer.address, outer.bits)

export const hostAt = (cidr: string, n: number) =>
  fromNumber(toNumber(mustParse(cidr).address) + n).toString()

export const slash24Index = (pool: Cidr, subnet: Cidr) =>
  subnet.address.octets[2]! - pool.address.octets[2]!

export const slash24At = (pool: string, index: number) => {
  const [a, b, c] = mustParse(pool).address.octets
  const subnet = `${new ipaddr.IPv4([a!, b!, c! + index, 0]).toString()}/24`

  return {
    subnet,
    gateway: hostAt(subnet, networkLayout.gatewayHost),
  }
}

export function* slash24sFrom(pool: string, first: number) {
  const third = mustParse(pool).address.octets[2]!

  for (let index = first; third + index < 256; index++) {
    yield slash24At(pool, index)
  }
}

export const registryAddress = (subnet: string) =>
  `${hostAt(subnet, networkLayout.registryHost)}:${networkLayout.registryPort}`
