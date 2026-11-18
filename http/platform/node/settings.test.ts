import { readFileSync } from 'node:fs'
import { Server as HTTPServer } from 'node:http'
import { Server as HTTPSServer } from 'node:https'
import { Server as NetServer } from 'node:net'
import { Server as TLSServer } from 'node:tls'

import { Second } from '@caffeinejs/std/duration'
import { describe, expect, it, vi } from 'vitest'

import { ErrConfiguration } from '../../core/error/common.js'
import { resolveNodeServerSettings } from './settings.js'

const key = readFileSync(new URL('../../_tests/_testdata/tls/localhost.key', import.meta.url))
const cert = readFileSync(new URL('../../_tests/_testdata/tls/localhost.crt', import.meta.url))

const noop = (): void => undefined

describe('resolveNodeServerSettings', () => {
  it.each([
    [{ listen: 3000 }, 'Cannot set listen: it must be an object of node:net options, not a number'],
    [{ http: [] }, 'Cannot set http: it must be an object of node:http options, not an array'],
    [{ https: 'tls' }, 'Cannot set https: it must be an object of node:https options, not a string'],
    [{ http2: 'yes' }, 'Cannot set http2: it must be true, false or an object of node:http2 options, not a string'],
    [{ http: {}, http2: true }, 'Cannot use the http section with http2: an HTTP/2 server takes no node:http options'],
    [
      { http2: { allowHTTP1: true } },
      'Cannot set http2.allowHTTP1 without https: only an HTTP/2 server over TLS falls back to HTTP/1.1',
    ],
  ])('refuses %j', (settings, message) => {
    expect(() => resolveNodeServerSettings(settings)).toThrow(ErrConfiguration)
    expect(() => resolveNodeServerSettings(settings)).toThrow(message)
  })

  // A key handed over as PEM text in place of the section must never reach a message, and so a log.
  it('refuses an https section that is not an object without printing it', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'

    expect(() => resolveNodeServerSettings({ https: pem })).toThrow(ErrConfiguration)
    expect(() => resolveNodeServerSettings({ https: pem })).not.toThrow(/secret/)
  })

  it('refuses a section it does not know', () => {
    expect(() => resolveNodeServerSettings({ factory: {} })).toThrow(
      'Cannot build the server: "factory" is not a setting of the Node application',
    )
  })

  it('refuses a trustProxy hop count and takes a list of addresses', () => {
    expect(() => resolveNodeServerSettings({ trustProxy: 1 })).toThrow('a hop count cannot tell a proxy from a client')
    expect(resolveNodeServerSettings({ trustProxy: 'loopback' }).engine.trustProxy?.('127.0.0.1')).toBe(true)
  })

  it('names the Node application and its sections when refusing an unknown setting', () => {
    expect(() => resolveNodeServerSettings({ port: 3000 })).toThrow(
      'Return only handlerTimeout, router, matcher, constraints, trustProxy, requestIDHeader, bodyLimit, schemaCompiler, listen, http, https, http2',
    )
  })

  it("builds an HTTP/1.1 server kept alive for Fastify's 72 seconds", () => {
    const server = resolveNodeServerSettings({}).createServer(noop)

    expect(server).toBeInstanceOf(HTTPServer)
    expect((server as HTTPServer).keepAliveTimeout).toBe(72 * Second)
  })

  it('keeps the keep-alive the http section sets', () => {
    const server = resolveNodeServerSettings({ http: { keepAliveTimeout: 1 * Second } }).createServer(noop)

    expect((server as HTTPServer).keepAliveTimeout).toBe(1 * Second)
  })

  it('builds an HTTPS server from the https section', () => {
    expect(resolveNodeServerSettings({ https: { key, cert } }).createServer(noop)).toBeInstanceOf(HTTPSServer)
  })

  it('builds a cleartext HTTP/2 server under http2', () => {
    const server = resolveNodeServerSettings({ http2: true }).createServer(noop)

    expect(server).toBeInstanceOf(NetServer)
    expect(server).not.toBeInstanceOf(HTTPServer)
    expect(server).not.toBeInstanceOf(TLSServer)
  })

  // Turning the fallback off asks for nothing a cleartext server lacks, as a shared configuration may write it.
  it('builds a cleartext HTTP/2 server with allowHTTP1 turned off', () => {
    const server = resolveNodeServerSettings({ http2: { allowHTTP1: false } }).createServer(noop)

    expect(server).toBeInstanceOf(NetServer)
    expect(server).not.toBeInstanceOf(TLSServer)
  })

  it('builds an HTTP/2 server over TLS under http2 and https', () => {
    const server = resolveNodeServerSettings({ https: { key, cert }, http2: true }).createServer(noop)

    expect(server).toBeInstanceOf(TLSServer)
    expect(server).not.toBeInstanceOf(HTTPSServer)
  })

  // Node sets none, so an abandoned session would hold its socket for good.
  it('closes an HTTP/2 session idle for 72 seconds', () => {
    const server = resolveNodeServerSettings({ http2: true }).createServer(noop)
    let seen: number | undefined
    const session = {
      setTimeout(ms: number, fn: () => void) {
        seen = ms
        fn()
      },
      close: vi.fn(),
    }

    server.emit('session', session)

    expect(seen).toBe(72 * Second)
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})
