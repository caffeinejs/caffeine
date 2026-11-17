import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../../core/error/common.js'
import { bunListenOptions, resolveBunServerSettings } from './settings.js'

function refusal(settings: object): string {
  try {
    resolveBunServerSettings(settings)
  } catch (err) {
    expect(err).toBeInstanceOf(ErrConfiguration)
    return (err as Error).message
  }

  throw new Error('expected resolveBunServerSettings to throw')
}

describe('bunListenOptions', () => {
  it("maps node:net's names to Bun's, so a listen section reads the same under node() and bun()", () => {
    expect(bunListenOptions({ host: '::1', port: 8080, reusePort: true }, undefined)).toEqual({
      hostname: '::1',
      port: 8080,
      reusePort: true,
    })
  })

  it('maps path to a Unix socket with no hostname or port', () => {
    expect(bunListenOptions({ path: '/tmp/s' }, undefined)).toEqual({ unix: '/tmp/s' })
  })

  it("listens on localhost on an OS port when nothing is set, never on Bun's 3000 or $PORT", () => {
    expect(bunListenOptions(undefined, undefined)).toEqual({ hostname: 'localhost', port: 0 })
  })

  // As node:net does: the same listen section binds the same way under node() and bun().
  it('lets a port win over a path', () => {
    expect(bunListenOptions({ path: '/tmp/s' }, { port: 3000 })).toEqual({ port: 3000 })
  })

  it('refuses a listen section with a host but no port or path, as node:net does', () => {
    expect(() => bunListenOptions({ host: 'a' }, undefined)).toThrow(ErrConfiguration)
    expect(() => bunListenOptions({ host: 'a' }, undefined)).toThrow(
      'Cannot listen: "listen" names no port and no path',
    )
  })

  // An option node:net takes and Bun does not would otherwise vanish from a configuration written for node().
  it('refuses a node:net option Bun does not take', () => {
    expect(() => bunListenOptions({ port: 1, backlog: 10 } as never, undefined)).toThrow(ErrConfiguration)
    expect(() => bunListenOptions({ port: 1, backlog: 10 } as never, undefined)).toThrow(
      'Cannot listen with "backlog" under bun(): Bun.serve does not take it',
    )
  })

  it('lets run(options) win key by key', () => {
    expect(bunListenOptions({ host: 'a', port: 1 }, { port: 2 })).toEqual({ hostname: 'a', port: 2 })
  })
})

describe('resolveBunServerSettings', () => {
  it('refuses http2, pointing at the Node adapter', () => {
    const message = refusal({ http2: true })

    expect(message.split('\n')[0]).toBe('Cannot build the server: "http2" is not a setting of the Bun application')
    expect(message).toContain(
      'Pass adapter: node() from "@caffeinejs/http/node" to createWebApplication() to serve on a Node server',
    )
    expect(message).toContain(
      'Return only handlerTimeout, router, matcher, constraints, trustProxy, requestIDHeader, bodyLimit, schemaCompiler, listen, https from ".server(...)"',
    )
  })

  it('refuses a listen section that is not an object', () => {
    expect(refusal({ listen: 3000 }).split('\n')[0]).toBe(
      'Cannot set listen: it must be an object of node:net options, not a number',
    )
  })

  // A key handed over as PEM text in place of the section must never reach a message, and so a log.
  it('refuses an https section that is not an object without printing it', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
    const message = refusal({ https: pem })

    expect(message.split('\n')[0]).toBe('Cannot set https: it must be an object of TLS options, not a string')
    expect(message).not.toContain('secret')
  })

  // A node:https option Bun does not take would otherwise vanish from a configuration written for node().
  it('refuses a TLS option Bun does not take', () => {
    expect(refusal({ https: { key: 'k', cert: 'c', minVersion: 'TLSv1.3' } }).split('\n')[0]).toBe(
      'Cannot serve TLS with "minVersion" under bun(): Bun.serve does not take it',
    )
  })

  // The address would say https while Bun serves no TLS at all.
  it('refuses an https section without a key and a certificate', () => {
    expect(refusal({ https: { key: 'k' } }).split('\n')[0]).toBe(
      'Cannot serve TLS: the https section needs a key and a cert',
    )
    expect(refusal({ https: {} }).split('\n')[0]).toBe('Cannot serve TLS: the https section needs a key and a cert')
  })

  it('trusts proxies by address, since Bun knows the peer', () => {
    const { engine } = resolveBunServerSettings({ trustProxy: 'loopback' })

    expect(engine.trustProxy!('127.0.0.1')).toBe(true)
    expect(engine.trustProxy!('10.0.0.1')).toBe(false)
  })

  it('hands the listen and https sections over as given', () => {
    const tls = { key: 'k', cert: 'c' }

    expect(resolveBunServerSettings({ listen: { port: 1 }, https: tls })).toMatchObject({
      listen: { port: 1 },
      tls,
    })
  })
})
