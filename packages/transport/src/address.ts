import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const publicRanges = new Set(['unicast', 'as112', 'amt', 'as112v6'])
const globalIpv6 = ipaddr.IPv6.parseCIDR('2000::/3')
const protocolIpv6 = ipaddr.IPv6.parseCIDR('2001::/23')
const reservedIpv6 = ipaddr.IPv6.parseCIDR('3fff::/16')

/** Conservative global-unicast policy; mapped, transition and documentation ranges are excluded. */
export function isPublicAddress(address: string): boolean {
  // DNS returns canonical literals. Reject shorthand and interface-scoped input
  // Before using the library's deliberately permissive address parser.
  if (isIP(address) === 0 || address.includes('%')) {
    return false
  }
  const parsed = ipaddr.parse(address)
  if (!publicRanges.has(parsed.range())) {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) {
    return true
  }
  // Retain the relay's conservative IPv6 allocation policy in addition to the
  // Library's maintained special-use ranges.
  const protocolReserved = parsed.match(protocolIpv6)
  const allocationReserved = parsed.match(reservedIpv6)
  return parsed.match(globalIpv6) && !protocolReserved && !allocationReserved
}
