import { MockAgent } from 'undici'
import { describe, expect, it } from 'vitest'

import { UndiciCall } from '../undici_call.js'

const ORIGIN = 'http://example.test'

function newMockPool(): { call: UndiciCall, mockPool: ReturnType<MockAgent['get']> } {
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  const mockPool = mockAgent.get(ORIGIN)

  return { call: new UndiciCall(mockPool), mockPool }
}

describe('UndiciCall', () => {
  it('translates a successful GET response', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'GET' }).reply(200, { id: '1' }, {
      headers: { 'content-type': 'application/json' },
    })

    const response = await call.execute(new Request(`${ORIGIN}/users/1`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ id: '1' })
  })

  it('translates a POST request/response', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users', method: 'POST' }).reply(201, { id: '1', name: 'Ada' })

    const request = new Request(`${ORIGIN}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    })

    const response = await call.execute(request)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: '1', name: 'Ada' })
  })

  it('returns a non-2xx response without throwing', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/nowhere', method: 'GET' }).reply(404, { error: 'not found' })

    const response = await call.execute(new Request(`${ORIGIN}/nowhere`))

    expect(response.status).toBe(404)
    expect(response.ok).toBe(false)
    expect(await response.json()).toEqual({ error: 'not found' })
  })

  it('produces a null body for a null-body status', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/users/1', method: 'DELETE' }).reply(204, '')

    const response = await call.execute(new Request(`${ORIGIN}/users/1`, { method: 'DELETE' }))

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('preserves repeated header values', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/login', method: 'POST' }).reply(200, {}, {
      headers: { 'set-cookie': ['a=1', 'b=2'] },
    })

    const response = await call.execute(new Request(`${ORIGIN}/login`, { method: 'POST' }))

    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('rejects when the request is aborted', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/slow', method: 'GET' }).reply(200, {}).delay(200)

    const controller = new AbortController()
    const request = new Request(`${ORIGIN}/slow`, { signal: controller.signal })

    setTimeout(() => controller.abort(), 10)

    await expect(call.execute(request)).rejects.toThrow()
  })

  it('propagates a dispatch-level error unwrapped', async () => {
    const { call, mockPool } = newMockPool()
    mockPool.intercept({ path: '/boom', method: 'GET' }).replyWithError(new Error('network down'))

    await expect(call.execute(new Request(`${ORIGIN}/boom`))).rejects.toThrow('network down')
  })
})
