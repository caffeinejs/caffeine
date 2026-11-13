import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { compileTrustProxy } from './trust.js'

// An application whose runtime says which address a request came from, as Node's does.
const ADDRESSED = { name: 'Node application', peerAddress: true }

function trusts(value: unknown): (address: string | undefined) => boolean {
  const trust = compileTrustProxy(value, ADDRESSED)

  if (trust === undefined) {
    throw new Error(`${String(value)} compiled to no trust test`)
  }

  return trust
}

describe('compileTrustProxy', () => {
  it('trusts no peer when unset or false', () => {
    expect(compileTrustProxy(undefined, ADDRESSED)).toBe(undefined)
    expect(compileTrustProxy(false, ADDRESSED)).toBe(undefined)
  })

  it('trusts any peer, one with no address included, under true', () => {
    expect(trusts(true)('8.8.8.8')).toBe(true)
    expect(trusts(true)(undefined)).toBe(true)
  })

  // A dual-stack socket reports an IPv4 client as an IPv4-mapped IPv6 address.
  it('matches an address however the socket writes it, and only that address', () => {
    const trust = trusts('127.0.0.1')

    expect(trust('127.0.0.1')).toBe(true)
    expect(trust('::ffff:127.0.0.1')).toBe(true)
    expect(trust('127.0.0.2')).toBe(false)
    expect(trust('::1')).toBe(false)
    expect(trust(undefined)).toBe(false)
    expect(trust('not-an-ip')).toBe(false)
  })

  it('expands loopback to both families', () => {
    expect(trusts('loopback')('127.5.5.5')).toBe(true)
    expect(trusts('loopback')('::1')).toBe(true)
  })

  it('reads a comma-separated string of ranges and addresses', () => {
    const trust = trusts('10.0.0.0/8, 192.168.0.1')

    expect(trust('10.9.9.9')).toBe(true)
    expect(trust('192.168.0.1')).toBe(true)
    expect(trust('192.168.0.2')).toBe(false)
  })

  it('expands uniquelocal to the private ranges of both families', () => {
    const trust = trusts(['uniquelocal'])

    expect(trust('172.16.3.4')).toBe(true)
    expect(trust('fd00::1')).toBe(true)
    expect(trust('8.8.8.8')).toBe(false)
  })

  it('matches an IPv4 peer against an IPv4-mapped IPv6 range', () => {
    expect(trusts(['::ffff:10.0.0.0/104'])('10.1.2.3')).toBe(true)
  })

  it('matches an IPv6 range', () => {
    expect(trusts(['fe80::/10'])('fe80::1')).toBe(true)
  })

  // A hop count cannot tell a proxy from a client, and an entry that parses as another host would trust it.
  it.each([
    [1, 'Cannot set trustProxy to "1": a hop count cannot tell a proxy from a client'],
    [0, 'Cannot set trustProxy to "0": a hop count cannot tell a proxy from a client'],
    ['', 'Cannot set trustProxy to an empty list: it would trust no proxy'],
    [' , ', 'Cannot set trustProxy to an empty list: it would trust no proxy'],
    [[], 'Cannot set trustProxy to an empty list: it would trust no proxy'],
    [['nope'], 'Cannot set trustProxy: "nope" is not an IP address, a CIDR range, loopback, linklocal or uniquelocal'],
    ['192.168.1', 'Cannot set trustProxy: "192.168.1" is not an IP address'],
    ['10.0.0.0/33', 'Cannot set trustProxy: "10.0.0.0/33" is not an IP address'],
    [[1], 'Cannot set trustProxy to "1": it must be true, false, a list of addresses or a comma-separated string'],
    [{}, 'Cannot set trustProxy to "[object Object]": it must be true, false, a list of addresses'],
  ])('refuses %j', (value, message) => {
    expect(() => compileTrustProxy(value, ADDRESSED)).toThrow(ErrConfiguration)
    expect(() => compileTrustProxy(value, ADDRESSED)).toThrow(message)
  })

  it('tells a reader who wrote the boolean as a string to write the boolean', () => {
    expect(() => compileTrustProxy('true', ADDRESSED)).toThrow('Write trustProxy: true as a boolean, not a string')
  })

  // Where the runtime gives no peer address, a list could never match: only a boolean is taken.
  it.each([
    [1, 'Cannot set trustProxy to "1": a hop count cannot tell a proxy from a client'],
    [
      'loopback',
      'Cannot set trustProxy to a list of addresses on the fetch application: the runtime does not say which address a request came from',
    ],
    [
      ['10.0.0.1'],
      'Cannot set trustProxy to a list of addresses on the fetch application: the runtime does not say which address a request came from',
    ],
    [{}, 'Cannot set trustProxy to "[object Object]": it must be true or false'],
  ])('refuses %j where the runtime gives no peer address, offering true', (value, first) => {
    let message = ''
    try {
      compileTrustProxy(value, { name: 'fetch application', peerAddress: false })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message.split('\n')[0]).toBe(first)
    expect(message).toContain('Write trustProxy: true when only trusted proxies can reach the application')
    expect(message.includes("Name the proxy's addresses")).toBe(false)
  })
})
