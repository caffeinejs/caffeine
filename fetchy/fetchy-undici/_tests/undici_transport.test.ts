import { FetchyHeaders, FetchyRequest, type FetchyResponse } from '@caffeinejs/fetchy'
import { MockAgent, Pool } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UndiciTransport } from '../undici_transport.js'
import { startTestServer, type TestServer } from './test_server.js'

const ORIGIN = 'http://example.test'

function newMockPool(): { transport: UndiciTransport; mockPool: ReturnType<MockAgent['get']> } {
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  const mockPool = mockAgent.get(ORIGIN)

  return { transport: new UndiciTransport(mockPool), mockPool }
}

describe('UndiciTransport', () => {
  it('translates a successful GET response', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(
      200,
      { id: '1' },
      {
        headers: { 'content-type': 'application/json' },
      },
    )

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/users/1'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ id: '1' })
  })

  // A @RawResponse caller gets this response as is, and may stream a large body instead of buffering it.
  it('still streams the body on demand', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/export', method: 'GET' }).reply(200, 'line 1\nline 2\n')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/export'))
    const chunks: string[] = []
    const decoder = new TextDecoder()

    for await (const chunk of response.body!) {
      chunks.push(decoder.decode(chunk, { stream: true }))
    }

    expect(chunks.join('')).toBe('line 1\nline 2\n')
    expect(response.bodyUsed).toBe(true)
  })

  // A body is read once. A second read fails the way it fails on a fetch Response, so a caller handles one error
  // whichever transport answered.
  it('rejects a second read as fetch does', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(200, { id: '1' })

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/users/1'))

    expect(response.bodyUsed).toBe(false)
    await response.text()
    expect(response.bodyUsed).toBe(true)
    await expect(response.json()).rejects.toThrow(new TypeError('Body is unusable: Body has already been read'))
  })

  it('translates a POST request/response', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users', method: 'POST' }).reply(201, { id: '1', name: 'Ada' })

    const request = new FetchyRequest(
      'POST',
      ORIGIN,
      '/users',
      new FetchyHeaders({ 'content-type': 'application/json' }),
      JSON.stringify({ name: 'Ada' }),
    )

    const response = await transport.send(request)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: '1', name: 'Ada' })
  })

  // The request builder never hands over a URLSearchParams, but an interceptor may. undici would write its entries
  // one by one and fail, while fetch sends the form string.
  it('sends a URLSearchParams body as its form string', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/form', method: 'POST', body: 'a=1&b=x+y' }).reply(200, {})

    const request = new FetchyRequest('POST', ORIGIN, '/form')
    request.body = new URLSearchParams({ a: '1', b: 'x y' })

    const response = await transport.send(request)

    expect(response.status).toBe(200)
  })

  it('returns a non-2xx response without throwing', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/nowhere', method: 'GET' }).reply(404, { error: 'not found' })

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/nowhere'))

    expect(response.status).toBe(404)
    expect(response.ok).toBe(false)
    expect(await response.json()).toEqual({ error: 'not found' })
  })

  it('produces a null body for a null-body status', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'DELETE' }).reply(204, '')

    const response = await transport.send(new FetchyRequest('DELETE', ORIGIN, '/users/1'))

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('preserves repeated header values', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/login', method: 'POST' }).reply(
      200,
      {},
      {
        headers: { 'set-cookie': ['a=1', 'b=2'] },
      },
    )

    const response = await transport.send(new FetchyRequest('POST', ORIGIN, '/login'))

    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('rejects when the request is aborted', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/slow', method: 'GET' }).reply(200, {}).delay(200)

    const controller = new AbortController()
    const request = new FetchyRequest('GET', ORIGIN, '/slow', new FetchyHeaders(), null, controller.signal)

    setTimeout(() => controller.abort(), 10)

    await expect(transport.send(request)).rejects.toThrow()
  })

  it('propagates a dispatch-level error unwrapped', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/boom', method: 'GET' }).replyWithError(new Error('network down'))

    await expect(transport.send(new FetchyRequest('GET', ORIGIN, '/boom'))).rejects.toThrow('network down')
  })
})

// Only a real pool holds a connection while a body is unread, so these run against a local server.
describe('UndiciTransport on a body cancelled unread', () => {
  let server: TestServer
  let pool: Pool

  beforeEach(async () => {
    server = await startTestServer()
    pool = new Pool(server.baseURL, { connections: 1 })
  })

  afterEach(async () => {
    await pool.destroy()
    await server.stop()
  })

  // More than the socket buffers hold, so the body is still arriving when it is cancelled.
  function sendLarge(transport: UndiciTransport): Promise<FetchyResponse> {
    const headers = new FetchyHeaders({ 'x-test-body-bytes': String(4 * 1024 * 1024) })

    return transport.send(new FetchyRequest('GET', server.baseURL, '/large', headers))
  }

  // A retried or re-authenticated call cancels the response it discards. With one connection in the pool, a body that
  // kept it would leave every later call waiting forever.
  it('gives the connection back to the pool', async () => {
    const transport = new UndiciTransport(pool)
    const response = await sendLarge(transport)

    await response.body!.cancel()

    const next = await transport.send(new FetchyRequest('GET', server.baseURL, '/ping'))

    expect(next.status).toBe(200)
    await next.text()
  })

  // A cancelled body reads as used, as a fetch body does, so a second read fails at once instead of waiting on a body
  // that will never arrive.
  it('marks the body used', async () => {
    const transport = new UndiciTransport(pool)
    const response = await sendLarge(transport)

    await response.body!.cancel()

    expect(response.bodyUsed).toBe(true)
    await expect(response.text()).rejects.toThrow(new TypeError('Body is unusable: Body has already been read'))
  })
})
