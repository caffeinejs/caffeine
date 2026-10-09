import { ErrFetchyHTTP, FetchyHeaders, FetchyRequest } from '@caffeinejs/fetchy'
import { describe, expect, it, vi } from 'vitest'

import { ErrFetchyLoggingInvalidRedactHeaderArgs } from '../errors.js'
import { ConsoleLogger, PinoLogger } from '../index.js'
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

const ORIGIN = 'http://example.test'

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })
}

describe('LoggingInterceptor', () => {
  it('LoggingInterceptor.DEFAULT logs without throwing and passes the response through', async () => {
    const request = new FetchyRequest('GET', ORIGIN, '/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    const response = await LoggingInterceptor.DEFAULT.intercept(chain)

    expect(response.status).toBe(200)
  })

  it('logs request/response headers and body at Level.BODY', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BODY, logger })
    const request = new FetchyRequest(
      'POST',
      ORIGIN,
      '/users',
      new FetchyHeaders({ 'content-type': 'application/json' }),
      JSON.stringify({ name: 'Ada' }),
    )
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1', name: 'Ada' })))

    await interceptor.intercept(chain)

    expect(logger.lines).toContain('--> POST http://example.test/users')
    expect(logger.lines.some(line => line.includes('content-type: application/json'))).toBe(true)
    expect(logger.lines).toContain(JSON.stringify({ name: 'Ada' }))
    expect(logger.lines).toContain(JSON.stringify({ id: '1', name: 'Ada' }))
    expect(logger.lines.some(line => line.startsWith('Took: '))).toBe(true)
    expect(logger.lines.some(line => line.startsWith('Body Size: '))).toBe(true)
  })

  // Logging reads the body, and the response converter after it has to read it again.
  it('leaves the response body readable after logging it at Level.BODY', async () => {
    const interceptor = new LoggingInterceptor({ level: Level.BODY, logger: new SpyLogger() })
    const chain = fakeChain(new FetchyRequest('GET', ORIGIN, '/users/1'), () =>
      Promise.resolve(jsonResponse({ id: '1' }, 201, 'Created')),
    )

    const response = await interceptor.intercept(chain)

    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(await response.json()).toEqual({ id: '1' })
  })

  it('does not log anything at Level.NONE', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.NONE, logger })
    const request = new FetchyRequest('GET', ORIGIN, '/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    const response = await interceptor.intercept(chain)

    expect(logger.called).toBe(false)
    expect(response.status).toBe(200)
  })

  it('redacts a registered header value, case-insensitively', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.HEADERS, logger })
    interceptor.redactHeader('Authorization')

    const request = new FetchyRequest(
      'GET',
      ORIGIN,
      '/users',
      new FetchyHeaders({ authorization: 'super-secret-value' }),
    )
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

    const request = new FetchyRequest('GET', ORIGIN, '/nowhere')
    const errorResponse = new Response(null, {
      status: 404,
      statusText: 'Not Found',
      headers: { 'x-secret': 'super-secret-value' },
    })
    const chain = fakeChain(request, () => Promise.reject(new ErrFetchyHTTP(request, errorResponse, null)))

    await expect(interceptor.intercept(chain)).rejects.toBeInstanceOf(ErrFetchyHTTP)

    expect(logger.lines.some(line => line.includes('404'))).toBe(true)
    expect(logger.lines).toContain('x-secret: ***')
    expect(logger.lines.some(line => line.startsWith('Took: '))).toBe(true)
    expect(logger.lines.some(line => line.startsWith('<-- HTTP Failed: '))).toBe(true)
  })

  it('logs a generic failure line for a non-ErrFetchyHTTP rejection, skipping the status block', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.HEADERS, logger })
    const request = new FetchyRequest('GET', ORIGIN, '/users')
    const chain = fakeChain(request, () => Promise.reject(new TypeError('network down')))

    await expect(interceptor.intercept(chain)).rejects.toThrow('network down')

    expect(logger.lines.some(line => /^<-- \d/.test(line))).toBe(false)
    expect(logger.lines.some(line => line.includes('HTTP Failed: network down'))).toBe(true)
  })

  it('omits the body for a non-textual content type at Level.BODY', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BODY, logger })
    const request = new FetchyRequest(
      'POST',
      ORIGIN,
      '/upload',
      new FetchyHeaders({ 'content-type': 'application/octet-stream' }),
      new Uint8Array([1, 2, 3]),
    )
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ ok: true })))

    await interceptor.intercept(chain)

    expect(logger.lines.some(line => line.includes('(body omitted)'))).toBe(true)
  })

  it('setLevel() changes behavior for the next intercept() call', async () => {
    const logger = new SpyLogger()
    const interceptor = new LoggingInterceptor({ level: Level.BASIC, logger })
    interceptor.setLevel(Level.NONE)

    const request = new FetchyRequest('GET', ORIGIN, '/users/1')
    const chain = fakeChain(request, () => Promise.resolve(jsonResponse({ id: '1' })))

    await interceptor.intercept(chain)

    expect(logger.called).toBe(false)
  })
})

describe('LoggingInterceptor lines', () => {
  function intercepting(level: Level) {
    const logger = new SpyLogger()

    return { logger, interceptor: new LoggingInterceptor({ level, logger }) }
  }

  // Without a content-type there is no telling text from bytes, and bytes printed as text are noise or a leak.
  it('omits a string body that names no content-type', async () => {
    const { logger, interceptor } = intercepting(Level.BODY)
    const request = new FetchyRequest('POST', ORIGIN, '/tokens', new FetchyHeaders(), 'grant_type=secret')

    await interceptor.intercept(fakeChain(request, () => Promise.resolve(jsonResponse({}))))

    expect(logger.lines).toContain('--> END POST (body omitted)')
    expect(logger.lines).not.toContain('grant_type=secret')
  })

  it.each([
    ['text/csv', 'id,name\n1,Ada'],
    ['application/problem+json', '{"title":"Not Found"}'],
  ])('logs a %s body as text', async (contentType, text) => {
    const { logger, interceptor } = intercepting(Level.BODY)
    const response = new Response(text, { status: 200, headers: { 'content-type': contentType } })

    await interceptor.intercept(fakeChain(new FetchyRequest('GET', ORIGIN, '/report'), () => Promise.resolve(response)))

    expect(logger.lines).toContain(text)
  })

  // HTTP/2 has no reason phrase, so a status text is often empty: the line still reads as one status and one URL.
  it('writes the status line of an empty status text without a gap', async () => {
    const { logger, interceptor } = intercepting(Level.BASIC)
    const request = new FetchyRequest('GET', ORIGIN, '/users/1')
    const failed = new Response(null, { status: 500, statusText: '' })

    await interceptor.intercept(fakeChain(request, () => Promise.resolve(jsonResponse({}, 200, ''))))
    await expect(
      interceptor.intercept(fakeChain(request, () => Promise.reject(new ErrFetchyHTTP(request, failed, null)))),
    ).rejects.toBeInstanceOf(ErrFetchyHTTP)

    expect(logger.lines).toContain('<-- 200 http://example.test/users/1')
    expect(logger.lines).toContain('<-- 500 http://example.test/users/1')
  })

  it('logs no header of a failure at Level.BASIC', async () => {
    const { logger, interceptor } = intercepting(Level.BASIC)
    const request = new FetchyRequest('GET', ORIGIN, '/users/1')
    const failed = new Response(null, { status: 503, statusText: 'Service Unavailable', headers: { 'x-trace': 'abc' } })

    await expect(
      interceptor.intercept(fakeChain(request, () => Promise.reject(new ErrFetchyHTTP(request, failed, null)))),
    ).rejects.toBeInstanceOf(ErrFetchyHTTP)

    expect(logger.lines).toContain('<-- 503 Service Unavailable http://example.test/users/1')
    expect(logger.lines.some(line => line.includes('x-trace'))).toBe(false)
  })

  it("logs the content-type and content-length of a request's body at Level.HEADERS, when it has them", async () => {
    const { logger, interceptor } = intercepting(Level.HEADERS)
    const labelled = new FetchyRequest(
      'POST',
      ORIGIN,
      '/users',
      new FetchyHeaders({ 'content-type': 'application/json', 'content-length': '14' }),
      '{"name":"Ada"}',
    )
    const unlabelled = new FetchyRequest('POST', ORIGIN, '/users', new FetchyHeaders(), new Uint8Array([1]))

    await interceptor.intercept(fakeChain(labelled, () => Promise.resolve(jsonResponse({}))))
    await interceptor.intercept(fakeChain(unlabelled, () => Promise.resolve(jsonResponse({}))))

    expect(logger.lines.filter(line => line.startsWith('Content-Type: '))).toEqual(['Content-Type: application/json'])
    expect(logger.lines.filter(line => line.startsWith('Content-Length: '))).toEqual(['Content-Length: 14'])
  })

  it.each([
    ['a 204, which has no body', new Response(null, { status: 204 }), '<-- END HTTP'],
    [
      'an image, which is not text',
      new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }),
      '<-- END HTTP (body omitted)',
    ],
  ])('ends the response of %s at Level.BODY without printing a body', async (_kind, response, end) => {
    const { logger, interceptor } = intercepting(Level.BODY)

    await interceptor.intercept(fakeChain(new FetchyRequest('GET', ORIGIN, '/x'), () => Promise.resolve(response)))

    expect(logger.lines).toContain(end)
  })
})

describe('PinoLogger', () => {
  it('writes info lines at the info level and error lines at the error level', () => {
    const calls: [number, unknown][] = []
    // The hook records each call instead of writing it, which keeps the test's output clean.
    const logger = new PinoLogger({
      hooks: {
        logMethod(args, _method, level) {
          calls.push([level, args[0]])
        },
      },
    })

    logger.info('--> GET http://example.test/users')
    logger.error('<-- HTTP Failed: network down')

    expect(calls).toEqual([
      [30, '--> GET http://example.test/users'],
      [50, '<-- HTTP Failed: network down'],
    ])
  })
})

describe('ConsoleLogger', () => {
  // Logged with the error that caused it, a failure shows its stack in the console.
  it('hands console.error the error along with the message', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cause = new TypeError('network down')

    try {
      const logger = new ConsoleLogger()

      logger.info('--> GET http://example.test/users')
      logger.error('<-- HTTP Failed: network down', cause)
      logger.error('Took: 3ms')

      expect(info).toHaveBeenCalledWith('--> GET http://example.test/users')
      expect(error).toHaveBeenNthCalledWith(1, '<-- HTTP Failed: network down', cause)
      expect(error).toHaveBeenNthCalledWith(2, 'Took: 3ms')
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })
})
