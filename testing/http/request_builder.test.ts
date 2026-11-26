import { describe, expect, it } from 'vitest'

import { newReq, newURL } from './index.js'

describe('newReq()', () => {
  it('sets a JSON body and the content-type header', () => {
    const init = newReq().json({ name: 'test' }).build()

    expect(init.body).toBe('{"name":"test"}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('sets the Authorization header from a bearer token', () => {
    const init = newReq().bearer('abc').build()

    expect(new Headers(init.headers).get('authorization')).toBe('Bearer abc')
  })

  it('builds a Request from path() and query()', () => {
    const req = newReq().path('/tasks/123').query('verbose', 'true').method('DELETE').toRequest()

    expect(req.method).toBe('DELETE')
    expect(new URL(req.url).pathname).toBe('/tasks/123')
    expect(new URL(req.url).searchParams.get('verbose')).toBe('true')
  })

  // `newReq().path(newURL(...).build())`: the path is concrete, never read as a template again.
  it('sends a URL newURL built as it is, a "*" in a value included', () => {
    const url = newURL('/pets/:id').param('id', 'AC*DC').build()

    expect(newReq().path(url).toRequest().url).toBe(url)
  })

  it('sends a query written in the path as it is', () => {
    expect(newReq().path('/search?q=*').toRequest().url).toBe('http://localhost/search?q=*')
  })

  it('throws from toRequest() when no path was set', () => {
    expect(() => newReq().toRequest()).toThrow('Cannot build request: no path set')
  })
})
