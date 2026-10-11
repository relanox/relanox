import { isIP } from 'node:net'

function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((value, part) => value * 256 + Number(part), 0)
}

const excludedIpv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 16],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3]
] as const

const excludedIpv4Bounds = excludedIpv4Ranges.map(([address, prefix]) => {
  const start = ipv4Number(address)
  return { start, end: start + 2 ** (32 - prefix) }
})

/** Conservative global-unicast policy; mapped, transition and documentation ranges are excluded. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Number(address)
    return !excludedIpv4Bounds.some(
      ({ start, end }) => value >= start && value < end
    )
  }
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname
      .slice(1, -1)
      .toLowerCase()

    const [firstPart = '0', secondPart = '0'] = normalized.split(':')
    const first = Number.parseInt(firstPart, 16)
    const second = Number.parseInt(secondPart || '0', 16)
    return (
      first >= 0x20_00 &&
      first <= 0x3f_ff &&
      !normalized.startsWith('2001:db8:') &&
      !(first === 0x20_01 && second < 0x02_00) &&
      first !== 0x20_02 &&
      first !== 0x3f_ff
    )
  }
  return false
}
