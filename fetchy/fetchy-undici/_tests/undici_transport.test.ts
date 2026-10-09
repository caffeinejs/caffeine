import { FetchyHeaders, FetchyRequest, type FetchyResponse } from '@caffeinejs/fetchy'
import { FormData as UndiciFormData, MockAgent, Pool } from 'undici'
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

  // A body locked to a reader belongs to that reader. fetch refuses a second consumer, so the two never split the bytes.
  it('rejects a read while a reader holds the body', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(200, { id: '1' })

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/users/1'))
    response.body!.getReader()

    await expect(response.text()).rejects.toThrow(new TypeError('Body is unusable: Body has already been read'))
  })

  // fetch counts a body as used the moment a read is requested, before any byte arrives, so whoever checks `bodyUsed`
  // to decide whether to cancel it sees the read already under way.
  it('marks the body used as soon as a read is requested', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/export', method: 'GET' }).reply(200, 'content')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/export'))
    const read = response.body!.getReader().read()

    expect(response.bodyUsed).toBe(true)
    await read
  })

  // A challenge often has no body at all. Read once, it is used like any other, so a second read rejects as fetch's
  // does, instead of failing an undici assertion synchronously.
  it('marks an empty body used once it is read', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(401, '')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/users/1'))

    await expect(response.text()).resolves.toBe('')
    expect(response.bodyUsed).toBe(true)
    await expect(response.text()).rejects.toThrow(new TypeError('Body is unusable: Body has already been read'))
  })

  // A body json(), text() or arrayBuffer() took is locked to that read, as fetch's is, so code that cancels whatever
  // nobody holds leaves it alone, whenever it first touched `body`.
  it.each([
    ['after the read', false],
    ['before the read', true],
  ])('hands out a locked body when it is first touched %s', async (_when, touchedFirst) => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(200, { id: '1' })

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/users/1'))

    if (touchedFirst) {
      expect(response.body).not.toBeNull()
    }

    await response.json()

    expect(response.body!.locked).toBe(true)
  })

  it('reads the body as an ArrayBuffer', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/export', method: 'GET' }).reply(200, 'content')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/export'))

    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('content')
  })

  // A cancelled body has nothing left to give: every read method rejects as fetch's do, arrayBuffer() included.
  it('rejects arrayBuffer() once the body is cancelled', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/export', method: 'GET' }).reply(200, 'content')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/export'))
    await response.body!.cancel()

    await expect(response.arrayBuffer()).rejects.toThrow(new TypeError('Body is unusable: Body has already been read'))
  })

  // The body is a byte stream, so a BYOB reader may read it. One that reaches the end has to be told it is done, or it
  // waits forever.
  it('reads the body through a BYOB reader to its end', async () => {
    const { transport, mockPool } = newMockPool()
    mockPool.intercept({ path: '/export', method: 'GET' }).reply(200, 'content')

    const response = await transport.send(new FetchyRequest('GET', ORIGIN, '/export'))
    const reader = response.body!.getReader({ mode: 'byob' })
    const decoder = new TextDecoder()
    let text = ''

    for (;;) {
      const { done, value } = await reader.read(new Uint8Array(4))

      if (done) {
        break
      }

      text += decoder.decode(value, { stream: true })
    }

    expect(text).toBe('content')
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

  // An authenticator may read part of a challenge and let go of it. Cancelled afterwards, the rest of the body still has
  // to give the only connection back.
  it('gives the connection back after a partial read', async () => {
    const transport = new UndiciTransport(pool)
    const response = await sendLarge(transport)
    const reader = response.body!.getReader()

    await reader.read()
    reader.releaseLock()
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

// MockAgent never runs undici's HTTP/1.1 writer, which sends what the transport encoded, so these run against a local
// server.
describe('UndiciTransport on a FormData body', () => {
  let server: TestServer
  let pool: Pool

  beforeEach(async () => {
    server = await startTestServer()
    pool = new Pool(server.baseURL)
  })

  afterEach(async () => {
    await pool.destroy()
    await server.stop()
  })

  interface Echo {
    headers: Record<string, string>
    body: string
  }

  async function echo(body: unknown): Promise<Echo> {
    const transport = new UndiciTransport(pool)
    const response = await transport.send(
      new FetchyRequest('POST', server.baseURL, '/upload', undefined, body as FetchyRequest['body']),
    )

    return (await response.json()) as Echo
  }

  // The global FormData is the one fetchy builds and callers hold. Handed to undici, it waited forever without sending
  // even the request head. A Pool's abort waits for dispatch, so the test's own timeout, not a signal, catches a return.
  it('sends a global FormData as multipart/form-data, with its boundary and its length', async () => {
    const form = new FormData()
    form.append('title', 'Q3 report')
    form.append('file', new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }))
    form.append('attachment', new Blob(['raw']))

    const echoed = await echo(form)
    const contentType = echoed.headers['content-type']
    const parts = await new Response(echoed.body, { headers: { 'content-type': contentType } }).formData()
    const file = parts.get('file') as File

    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(Number(echoed.headers['content-length'])).toBe(Buffer.byteLength(echoed.body))
    expect(parts.get('title')).toBe('Q3 report')
    expect(file.name).toBe('report.pdf')
    expect(await file.text()).toBe('%PDF-1.7')
    expect((parts.get('attachment') as File).name).toBe('blob')
  })

  it("streams undici's own FormData the same way", async () => {
    const form = new UndiciFormData()
    form.append('title', 'Q3 report')

    const echoed = await echo(form)
    const parts = await new Response(echoed.body, {
      headers: { 'content-type': echoed.headers['content-type'] },
    }).formData()

    expect(parts.get('title')).toBe('Q3 report')
  })
})
