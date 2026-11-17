import ipaddr from 'ipaddr.js'

import { configurationError, USE_ADAPTER } from './error.js'
import type { ApplicationKind } from './settings.js'

/** Whether the peer at `address` is a proxy whose `X-Forwarded-Host` and `X-Forwarded-Proto` the server believes. */
export type TrustProxy = (address: string | undefined) => boolean

type Range = readonly [ipaddr.IPv4 | ipaddr.IPv6, number]

const NAMED: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.1/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}

const trustAll: TrustProxy = () => true

/**
 * The trust test `trustProxy` describes on `application`, or `undefined` for none. Where its runtime gives no peer
 * address, only a boolean is taken.
 *
 * @throws ErrConfiguration for a number, a list where the runtime gives no peer address, an empty string or list, an
 *   entry that is not an IP address, a CIDR range or `loopback`, `linklocal` or `uniquelocal`, and any other type.
 */
export function compileTrustProxy(
  value: unknown,
  application: Pick<ApplicationKind, 'name' | 'peerAddress'>,
): TrustProxy | undefined {
  if (value === undefined || value === false) {
    return undefined
  }

  if (value === true) {
    return trustAll
  }

  // Where the runtime gives no peer address, naming proxies is no way out: only `true` is.
  const onlyTrue = [
    'Write trustProxy: true when only trusted proxies can reach the application',
    `${USE_ADAPTER} to trust proxies by address`,
  ]

  if (typeof value === 'number') {
    throw configurationError(
      `Cannot set trustProxy to "${value}": a hop count cannot tell a proxy from a client`,
      ...(application.peerAddress
        ? [
            `Name the proxy's addresses, such as trustProxy: "10.0.0.0/8" or ["loopback", "10.0.0.1"]`,
            'Write trustProxy: true when only trusted proxies can reach the server',
          ]
        : onlyTrue),
    )
  }

  if (!application.peerAddress) {
    throw configurationError(
      typeof value === 'string' || Array.isArray(value)
        ? `Cannot set trustProxy to a list of addresses on the ${application.name}: the runtime does not say which address a request came from`
        : `Cannot set trustProxy to "${String(value)}": it must be true or false`,
      ...onlyTrue,
    )
  }

  let entries: string[]
  if (typeof value === 'string') {
    entries = value.split(',').map(entry => entry.trim())
  } else if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    entries = (value as string[]).map(entry => entry.trim())
  } else {
    throw configurationError(
      `Cannot set trustProxy to "${String(value)}": it must be true, false, a list of addresses or a comma-separated string`,
      'Write trustProxy: true, or a list such as ["loopback"]',
    )
  }

  entries = entries.filter(entry => entry !== '')
  if (entries.length === 0) {
    throw configurationError(
      'Cannot set trustProxy to an empty list: it would trust no proxy',
      'Leave trustProxy out to trust no proxy',
    )
  }

  const ranges = entries.flatMap(rangesOf)

  return address => {
    if (address === undefined) {
      return false
    }

    let ip: ipaddr.IPv4 | ipaddr.IPv6
    try {
      ip = ipaddr.process(address)
    } catch {
      // Not an address: no proxy is.
      return false
    }

    const kind = ip.kind()
    return ranges.some(([range, bits]) => kind === range.kind() && ip.match(range, bits))
  }
}

function rangesOf(entry: string): Range[] {
  const named = NAMED[entry]
  if (named !== undefined) {
    return named.map(cidr => normalized(ipaddr.parseCIDR(cidr)))
  }

  const slash = entry.indexOf('/')
  const address = slash === -1 ? entry : entry.slice(0, slash)

  // An IPv4 address in fewer than four parts, such as "192.168.1", would parse as another host.
  const valid = ipaddr.isValid(address) && (address.includes(':') || ipaddr.IPv4.isValidFourPartDecimal(address))

  try {
    if (valid) {
      if (slash !== -1) {
        return [normalized(ipaddr.parseCIDR(entry))]
      }

      const parsed = ipaddr.parse(entry)
      return [normalized([parsed, parsed.kind() === 'ipv4' ? 32 : 128])]
    }
  } catch {
    // A prefix length out of range: refused below.
  }

  throw configurationError(
    `Cannot set trustProxy: "${entry}" is not an IP address, a CIDR range, loopback, linklocal or uniquelocal`,
    ...(entry === 'true' || entry === 'false' ? [`Write trustProxy: ${entry} as a boolean, not a string`] : []),
    'Write an address such as "10.0.0.1", a range such as "10.0.0.0/8", or a name such as "loopback"',
  )
}

// An IPv4-mapped IPv6 range, such as "::ffff:10.0.0.0/104", is the IPv4 range it maps: peers are matched as IPv4.
function normalized([address, bits]: readonly [ipaddr.IPv4 | ipaddr.IPv6, number]): Range {
  if (address.kind() === 'ipv6' && bits >= 96 && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    return [(address as ipaddr.IPv6).toIPv4Address(), bits - 96]
  }

  return [address, bits]
}
