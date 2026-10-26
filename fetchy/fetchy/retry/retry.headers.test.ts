import { type Duration, Microsecond, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { newClient } from '../client_builder.js'
import {
  API,
  Body,
  GET,
  Params,
  POST,
  PUT,
  RawResponse,
  SignalParam,
  UseRequestBodyConverter,
} from '../decorators/index.js'
import { RawRequestBodyConverter } from '../request_body_converter.js'
import type { FetchyResponse } from '../response.js'
import { TestTransportFactory } from '../test_transport_factory.testkit.js'
import { ErrFetchyInvalidRetryOptions, Retry, NoRetry, RetryInterceptor } from './index.js'
import type { RetryOptions } from './options.js'

function client(options: Partial<RetryOptions> = {}, withInterceptor = true) {
  @API('/items')
  @Retry({ delay: Second, ...options })
  class ItemsAPI {
    @GET('/')
    @RawResponse()
    @Params([SignalParam()])
    get!: (signal?: AbortSignal) => Promise<FetchyResponse>

    @GET('/')
    @RawResponse()
    @NoRetry()
    noRetry!: () => Promise<FetchyResponse>

    @POST('/')
    @RawResponse()
    post!: () => Promise<FetchyResponse>

    @PUT('/')
    @RawResponse()
    @UseRequestBodyConverter(RawRequestBodyConverter)
    @Params([Body()])
    put!: (body: ReadableStream<Uint8Array>) => Promise<FetchyResponse>

    @GET('/')
    @RawResponse()
    @Retry({ delay: Second })
    override!: () => Promise<FetchyResponse>
  }

  const factory = new TestTransportFactory()
  const builder = newClient().baseURL('http://example.test').transportFactory(factory)
  if (withInterceptor) {
    builder.addInterceptor(RetryInterceptor.INSTANCE)
  }
  const api = builder.build().create(ItemsAPI)
  return { api, transport: factory.transports[0] }
}

function responseAfter(header?: string, status = 503): Response {
  return new Response('busy', { status, headers: header === undefined ? {} : { 'ReTrY-AfTeR': header } })
}

async function expectRetryAfter(header: string | undefined, delay: Duration, options?: Partial<RetryOptions>) {
  const { api, transport } = client(options)
  const success = new Response('ok')
  transport.willRespond(responseAfter(header)).willRespond(success)
  const call = api.get()

  await vi.advanceTimersByTimeAsync(delay - Millisecond)
  expect(transport.sendCount).toBe(1)

  await vi.advanceTimersByTimeAsync(Millisecond)
  await expect(call).resolves.toBe(success)
  expect(transport.sendCount).toBe(2)
}

describe('Retry-After', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the default header when a dynamically configured name is undefined', async () => {
    await expectRetryAfter('2', 2 * Second, { retryAfterHeader: undefined })
  })

  it.each(['X-Retry-After', 'x-retry-after'])(
    'uses the configured %s header without mixing in the default header',
    async retryAfterHeader => {
      const { api, transport } = client({ retryAfterHeader })
      const response = responseAfter('60')
      response.headers.set('X-Retry-After', '2')
      const success = new Response('ok')
      transport.willRespond(response).willRespond(success)
      const call = api.get()

      await vi.advanceTimersByTimeAsync(2 * Second - Millisecond)
      expect(transport.sendCount).toBe(1)
      await vi.advanceTimersByTimeAsync(Millisecond)
      await expect(call).resolves.toBe(success)
      expect(transport.sendCount).toBe(2)
    },
  )

  it('uses the configured delay when only the unselected default header is present', async () => {
    await expectRetryAfter('60', Second, { retryAfterHeader: 'x-retry-after' })
  })

  it('uses HTTP dates from a custom retry header', async () => {
    const { api, transport } = client({ retryAfterHeader: 'x-retry-after' })
    const response = responseAfter()
    response.headers.set('x-retry-after', 'Fri, 23 Oct 2026 12:00:02 GMT')
    const success = new Response('ok')
    transport.willRespond(response).willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(2 * Second - Millisecond)
    expect(transport.sendCount).toBe(1)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
  })

  it('applies the server wait cap to a custom header', async () => {
    const { api, transport } = client({ retryAfterHeader: 'x-retry-after', maxRetryAfter: Second })
    const response = responseAfter()
    response.headers.set('x-retry-after', '2')
    transport.willRespond(response)

    await expect(api.get()).resolves.toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(transport.sendCount).toBe(1)
  })

  it('lets a method override restore the default header name', async () => {
    const { api, transport } = client({ retryAfterHeader: 'x-retry-after' })
    const response = responseAfter('2')
    response.headers.set('x-retry-after', '60')
    const success = new Response('ok')
    transport.willRespond(response).willRespond(success)
    const call = api.override()

    await vi.advanceTimersByTimeAsync(2 * Second - Millisecond)
    expect(transport.sendCount).toBe(1)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
  })

  // The name is quoted escaped, so a newline in it cannot split the first line of the message.
  it.each([
    ['', '""'],
    ['retry after', '"retry after"'],
    ['retry-after:', '"retry-after:"'],
    ['retry\nAfter', '"retry\\nAfter"'],
  ])('rejects invalid header name %j before making requests', (retryAfterHeader, quoted) => {
    let error: unknown
    try {
      client({ retryAfterHeader })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ErrFetchyInvalidRetryOptions)
    expect((error as ErrFetchyInvalidRetryOptions).code).toBe('ERR_FETCHY_INVALID_RETRY_OPTIONS')
    expect((error as ErrFetchyInvalidRetryOptions).message.split('\n')[0]).toBe(
      `Cannot apply @Retry: retryAfterHeader ${quoted} is not a valid header name`,
    )
  })

  it('rounds a fractional network retry delay up so that the next attempt is not early', async () => {
    const { api, transport } = client({ delay: 1_500 * Microsecond })
    const success = new Response('ok')
    transport.willFail(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(Millisecond)
    expect(transport.sendCount).toBe(1)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
    expect(transport.sendCount).toBe(2)
  })

  it.each([
    ['seconds', '2'],
    ['leading zeroes', '002'],
    ['surrounding whitespace', ' \t2\t '],
    ['IMF-fixdate', 'Fri, 23 Oct 2026 12:00:02 GMT'],
    ['RFC 850', 'Friday, 23-Oct-26 12:00:02 GMT'],
    ['asctime', 'Fri Oct 23 12:00:02 2026'],
  ])('does not retry before the server permits it using %s', async (_name, header) => {
    await expectRetryAfter(header, 2 * Second)
  })

  it('reads a single-digit asctime day in UTC', async () => {
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
    await expectRetryAfter('Sat Oct  3 12:00:02 2026', 2 * Second)
  })

  it('calculates the remaining date delay from the response time', async () => {
    vi.setSystemTime(new Date('2026-10-23T12:00:00.250Z'))
    await expectRetryAfter('Fri, 23 Oct 2026 12:00:02 GMT', 1_750 * Millisecond)
  })

  it('interprets RFC 850 years relative to the current century, not a fixed 1950 cutoff', async () => {
    vi.setSystemTime(new Date('2050-01-01T00:00:00Z'))
    await expectRetryAfter('Saturday, 01-Jan-50 00:00:02 GMT', 2 * Second)
  })

  it('interprets a two-digit year across the next century', async () => {
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'))
    await expectRetryAfter('Friday, 01-Jan-00 00:00:01 GMT', 2 * Second)
  })

  it('treats an RFC 850 date more than fifty years ahead as a past date', async () => {
    await expectRetryAfter('Friday, 23-Oct-76 12:00:01 GMT', Second)
  })

  it('does not send early when an HTTP date includes a leap second', async () => {
    vi.setSystemTime(new Date('2016-12-31T23:59:58Z'))
    await expectRetryAfter('Sat, 31 Dec 2016 23:59:60 GMT', 2 * Second)
  })

  it.each([
    ['zero', '0'],
    ['a past date', 'Thu, 22 Oct 2026 12:00:00 GMT'],
    ['a date at the current time', 'Fri, 23 Oct 2026 12:00:00 GMT'],
    ['a shorter server wait', '1'],
  ])('preserves the configured minimum delay for %s', async (_name, header) => {
    await expectRetryAfter(header, 2 * Second, { delay: 2 * Second })
  })

  it.each([
    undefined,
    '',
    ' ',
    '-1',
    '+2',
    '1.5',
    '1e3',
    '0x10',
    'Infinity',
    'NaN',
    'tomorrow',
    '2 seconds',
    '2, 3',
    '2026-10-23T12:00:02Z',
    'Fri, 23 Oct 2026 12:00:02 GMT, 2',
    'Fri, 31 Feb 2027 12:00:02 GMT',
    'Fri, 23 Xxx 2026 12:00:02 GMT',
    'Fri, 00 Oct 2026 12:00:02 GMT',
    'Fri, 23 Oct 2026 24:00:02 GMT',
    'Fri, 23 Oct 2026 12:60:02 GMT',
    'Fri, 23 Oct 2026 12:00:61 GMT',
  ])('falls back to the configured delay for an absent or invalid value %s', async header => {
    await expectRetryAfter(header, Second, { maxRetryAfter: 0 })
  })

  it.each([413, 429, 503])('honors the header on an eligible %i response', async status => {
    const { api, transport } = client()
    const success = new Response('ok')
    transport.willRespond(responseAfter('2', status)).willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(2 * Second - Millisecond)
    expect(transport.sendCount).toBe(1)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
  })

  it('uses each response header instead of retaining the previous wait', async () => {
    const { api, transport } = client()
    const success = new Response('ok')
    transport.willRespond(responseAfter('2')).willRespond(responseAfter('3')).willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(transport.sendCount).toBe(2)
    await vi.advanceTimersByTimeAsync(3 * Second - Millisecond)
    expect(transport.sendCount).toBe(2)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
    expect(transport.sendCount).toBe(3)
  })

  it('uses the configured delay on a transport failure after a server-directed wait', async () => {
    const { api, transport } = client()
    const success = new Response('ok')
    transport
      .willRespond(responseAfter('2'))
      .willFail(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(3 * Second - Millisecond)
    expect(transport.sendCount).toBe(2)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
  })

  it.each([
    ['a configured cap', '3', 2 * Second],
    ['a zero cap', '1', 0],
    ['a date beyond the cap', 'Fri, 23 Oct 2026 12:00:03 GMT', 2 * Second],
    ['a configured cap with numeric overflow', '9'.repeat(400), 2 * Second],
    ['the timer range', '2147484', undefined],
    ['the timer range despite a larger cap', '2147484', 3_000_000 * Second],
    ['a date beyond the timer range', 'Fri, 01 Jan 2100 00:00:00 GMT', undefined],
    ['the timer range with numeric overflow', '9'.repeat(400), undefined],
  ])('preserves the response instead of retrying early when exceeding %s', async (_name, header, maxRetryAfter) => {
    const { api, transport } = client({ maxRetryAfter })
    const response = responseAfter(header)
    transport.willRespond(response)

    await expect(api.get()).resolves.toBe(response)
    expect(transport.sendCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(response.bodyUsed).toBe(false)
    await expect(response.text()).resolves.toBe('busy')
  })

  it('accepts a server wait equal to the cap', async () => {
    await expectRetryAfter('2', 2 * Second, { maxRetryAfter: 2 * Second })
  })

  it('accepts the largest safe timer delay without wrapping to an early retry', async () => {
    vi.setSystemTime(new Date('2026-10-23T12:00:00.353Z'))
    const delay = 2_147_483_647 * Millisecond
    const header = new Date(Date.now() + delay).toUTCString()
    await expectRetryAfter(header, delay)
  })

  it('honors the header on a status explicitly enabled by the caller', async () => {
    const { api, transport } = client({ statusCodes: [409] })
    const success = new Response('ok')
    transport.willRespond(responseAfter('2', 409)).willRespond(success)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(2 * Second - Millisecond)
    expect(transport.sendCount).toBe(1)
    await vi.advanceTimersByTimeAsync(Millisecond)
    await expect(call).resolves.toBe(success)
  })

  it('lets zero server delay use a longer configured delay even with a zero cap', async () => {
    await expectRetryAfter('0', Second, { maxRetryAfter: 0 })
  })

  it('allows a method override to replace an inherited server wait cap', async () => {
    const { api, transport } = client({ maxRetryAfter: Second })
    const success = new Response('ok')
    transport.willRespond(responseAfter('2')).willRespond(success)
    const call = api.override()

    await vi.advanceTimersByTimeAsync(2 * Second)
    await expect(call).resolves.toBe(success)
    expect(transport.sendCount).toBe(2)
  })

  it('releases the discarded body before waiting and cancels the wait on abort', async () => {
    const { api, transport } = client()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status: 503, headers: { 'retry-after': '60' } })
    transport.willRespond(response)
    const controller = new AbortController()
    const reason = new Error('caller stopped waiting')
    const call = api.get(controller.signal)
    const rejected = expect(call).rejects.toBe(reason)

    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    controller.abort(reason)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * Second)
    expect(transport.sendCount).toBe(1)
  })

  it.each(['2', '60'])('rejects an already aborted call with header %s and releases its body', async header => {
    const { api, transport } = client({ maxRetryAfter: 30 * Second })
    const response = responseAfter(header)
    transport.willRespond(response)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(api.get(controller.signal)).rejects.toBe(reason)
    expect(response.bodyUsed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(transport.sendCount).toBe(1)
  })

  it.each([200, 404])('does not let a header make status %i eligible for retry', async status => {
    const { api, transport } = client()
    const response = responseAfter('2', status)
    transport.willRespond(response)

    await expect(api.get()).resolves.toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(transport.sendCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['noRetry', 'post'] as const)('does not let a header retry the %s operation', async method => {
    const { api, transport } = client()
    const response = responseAfter('2')
    transport.willRespond(response)

    await expect(api[method]()).resolves.toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(transport.sendCount).toBe(1)
  })

  it('does not let a header replay a stream body', async () => {
    const { api, transport } = client()
    const response = responseAfter('2')
    transport.willRespond(response)

    await expect(api.put(new ReadableStream())).resolves.toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(transport.sendCount).toBe(1)
  })

  it('does not let a header bypass the attempt limit', async () => {
    const { api, transport } = client({ limit: 2 })
    const last = responseAfter('60')
    transport.willRespond(responseAfter('2')).willRespond(last)
    const call = api.get()

    await vi.advanceTimersByTimeAsync(2 * Second)
    await expect(call).resolves.toBe(last)
    expect(last.bodyUsed).toBe(false)
    expect(transport.sendCount).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes no retries without the interceptor', async () => {
    const { api, transport } = client({}, false)
    const response = responseAfter('2')
    transport.willRespond(response)

    await expect(api.get()).resolves.toBe(response)
    expect(transport.sendCount).toBe(1)
  })
})
