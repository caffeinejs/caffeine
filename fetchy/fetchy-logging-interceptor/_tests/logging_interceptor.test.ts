import { ErrFetchyHTTP } from '@caffeinejs/fetchy'
import { describe, expect, it } from 'vitest'

import { ErrFetchyLoggingInvalidRedactHeaderArgs } from '../errors.js'
import { Level } from '../level.js'
import type { Logger } from '../logger.js'
import { LoggingInterceptor } from '../logging_interceptor.js'
import { fakeChain } from './fake_chain.js'

class SpyLogger implements Logger {
  readonly lines: string[] = []
  called = false

  info(message: string): void {
    this.called = true
    this.lines.push(message)
  }

  error(message: string): void {
    this.called = true
    this.lines.push(message)
  }
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })
}

describe('LoggingInterceptor', () => {
  it('LoggingInterceptor.DEFAULT logs without throwing and passes the response through', async () => {
    const request = new Request('http://example.test/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    const response = await LoggingInterceptor.DEFAULT.intercept(chain)

    expect(response.status).toBe(200)
  })

  it('logs request/response headers and body at Level.BODY', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BODY, logger })
    const request = new Request('http://example.test/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    })
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1', name: 'Ada' })))

    await interceptor.intercept(chain)

    expect(logger.lines).toContain('--> POST http://example.test/users')
    expect(logger.lines.some(line => line.includes('content-type: application/json'))).toBe(true)
    expect(logger.lines).toContain(JSON.stringify({ name: 'Ada' }))
    expect(logger.lines).toContain(JSON.stringify({ id: '1', name: 'Ada' }))
    expect(logger.lines.some(line => line.startsWith('Took: '))).toBe(true)
    expect(logger.lines.some(line => line.startsWith('Body Size: '))).toBe(true)
  })

  it('does not log anything at Level.NONE', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.NONE, logger })
    const request = new Request('http://example.test/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    const response = await interceptor.intercept(chain)

    expect(logger.called).toBe(false)
    expect(response.status).toBe(200)
  })

  it('redacts a registered header value, case-insensitively', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.HEADERS, logger })
    interceptor.redactHeader('Authorization')

    const request = new Request('http://example.test/users', {
      headers: { authorization: 'super-secret-value' },
    })
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    await interceptor.intercept(chain)

    expect(logger.lines.some(line => line.includes('super-secret-value'))).toBe(false)
    expect(logger.lines).toContain('authorization: ***')
  })

  it('throws ErrFetchyLoggingInvalidRedactHeaderArgs when redactHeader is called with no names', () => {
    const interceptor = new LoggingInterceptor()

    expect(() => interceptor.redactHeader()).toThrow(ErrFetchyLoggingInvalidRedactHeaderArgs)
  })

  it('logs the status and redacted headers on an ErrFetchyHTTP failure, then re-throws', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.HEADERS, logger })
    interceptor.redactHeader('x-secret')

    const request = new Request('http://example.test/nowhere')
    const errorResponse = new Response(null, {
      status: 404,
      statusText: 'Not Found',
      headers: { 'x-secret': 'super-secret-value' },
    })
    const chain = fakeChain(request, () =>
      Promise.reject(new ErrFetchyHTTP(request, errorResponse, null)),
    )

    await expect(interceptor.intercept(chain)).rejects.toBeInstanceOf(ErrFetchyHTTP)

    expect(logger.lines.some(line => line.includes('404'))).toBe(true)
    expect(logger.lines).toContain('x-secret: ***')
    expect(logger.lines.some(line => line.startsWith('Took: '))).toBe(true)
    expect(logger.lines.some(line => line.startsWith('<-- HTTP Failed: '))).toBe(true)
  })

  it('logs a generic failure line for a non-ErrFetchyHTTP rejection, skipping the status block', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.HEADERS, logger })
    const request = new Request('http://example.test/users')
    const chain = fakeChain(request, () => Promise.reject(new TypeError('network down')))

    await expect(interceptor.intercept(chain)).rejects.toThrow('network down')

    expect(logger.lines.some(line => /^<-- \d/.test(line))).toBe(false)
    expect(logger.lines.some(line => line.includes('HTTP Failed: network down'))).toBe(true)
  })

  it('omits the body for a non-textual content type at Level.BODY', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BODY, logger })
    const request = new Request('http://example.test/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    })
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ ok: true })))

    await interceptor.intercept(chain)

    expect(logger.lines.some(line => line.includes('(body omitted)'))).toBe(true)
  })

  it('setLevel() changes behavior for the next intercept() call', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BASIC, logger })
    interceptor.setLevel(Level.NONE)

    const request = new Request('http://example.test/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    await interceptor.intercept(chain)

    expect(logger.called).toBe(false)
  })
})
