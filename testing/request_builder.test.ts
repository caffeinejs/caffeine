import { describe, expect, it } from 'vitest'
import { newRequest } from './index.js'

describe('newRequest()', () => {
  it('sets a JSON body and the content-type header', () => {
    const init = newRequest().json({ name: 'test' }).build()

    expect(init.body).toBe('{"name":"test"}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('sets the Authorization header from a bearer token', () => {
    const init = newRequest().bearer('abc').build()

    expect(new Headers(init.headers).get('authorization')).toBe('Bearer abc')
  })

  it('builds a Request from path() and query()', () => {
    const req = newRequest().path('/tasks/123').query('verbose', 'true').method('DELETE').toRequest()

    expect(req.method).toBe('DELETE')
    expect(new URL(req.url).pathname).toBe('/tasks/123')
    expect(new URL(req.url).searchParams.get('verbose')).toBe('true')
  })

  it('throws from toRequest() when no path was set', () => {
    expect(() => newRequest().toRequest()).toThrow('Cannot build request: no path set')
  })
})
