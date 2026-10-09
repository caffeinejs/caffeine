import { describe, expect, it } from 'vitest'

import type { MethodSpec } from '../decorators/registrar/index.js'
import { ErrFetchyMissingPathArgument } from '../errors.js'
import { RequestBuilder } from '../request_builder.js'

function methodMeta(overrides: Partial<MethodSpec> = {}): MethodSpec {
  return {
    name: 'op',
    httpMethod: '',
    path: '',
    headers: new Headers(),
    params: [],
    formURLEncoded: false,
    multipart: false,
    responseConverter: undefined,
    requestBodyConverter: undefined,
    responseHandler: undefined,
    callback: false,
    retry: undefined,
    noRetry: false,
    ...overrides,
  }
}

describe('RequestBuilder', () => {
  it('substitutes path parameters', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users/{id}/posts/{postID}',
      params: [
        { kind: 'path', key: 'id', index: 0 },
        { kind: 'path', key: 'postID', index: 1 },
      ],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['1', '2'])

    expect(request.url).toBe('http://example.test/users/1/posts/2')
    expect(request.method).toBe('GET')
  })

  // A placeholder may repeat; every occurrence takes the same argument, as it did when the path was rewritten per call.
  it('fills every occurrence of a repeated placeholder', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users/{id}/friends/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['1'])

    expect(request.url).toBe('http://example.test/users/1/friends/1')
  })

  // `String(undefined)` is "undefined", and `/users/undefined` is a route like any other: a DELETE sent there acts on
  // whatever it names. A missing path argument has to stop the request instead.
  it('refuses to fill a path placeholder from an undefined or null argument', () => {
    const builder = new RequestBuilder(
      'http://example.test',
      methodMeta({ httpMethod: 'DELETE', path: '/users/{id}', params: [{ kind: 'path', key: 'id', index: 0 }] }),
    )

    expect(() => builder.toRequest([undefined])).toThrow(ErrFetchyMissingPathArgument)
    expect(() => builder.toRequest([null])).toThrow(
      'Cannot build request "DELETE /users/{id}": the argument for "{id}" is null',
    )
  })

  // undici's pool is bound to an origin and sends `path` as is, so a versioned base URL's own path has to be in the
  // request path, or every call would miss the `/v1`.
  it("keeps the base URL's own path in front of the method path", () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test/v1', meta).toRequest(['1'])

    expect(request.origin).toBe('http://example.test')
    expect(request.path).toBe('/v1/users/1')
    expect(request.url).toBe('http://example.test/v1/users/1')
  })

  it('appends query parameters, including arrays as repeated entries', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      params: [
        { kind: 'query', key: 'active', index: 0 },
        { kind: 'query', key: 'tag', index: 1 },
      ],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([true, ['a', 'b']])

    expect(request.url).toBe('http://example.test/users?active=true&tag=a&tag=b')
  })

  it('skips undefined/null query values', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      params: [{ kind: 'query', key: 'active', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([undefined])

    expect(request.url).toBe('http://example.test/users')
  })

  it('appends header parameters on top of default headers', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      headers: new Headers({ 'x-default': '1' }),
      params: [{ kind: 'header', key: 'x-trace', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['abc'])

    expect(request.headers.get('x-default')).toBe('1')
    expect(request.headers.get('x-trace')).toBe('abc')
  })

  // Header names are case-insensitive: a declared `accept` and an `Accept` argument are one header, joined the way
  // `Headers.append` joins them, never two headers the server has to pick between.
  it('joins a header argument onto a declared header of the same name, whatever its case', () => {
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      headers: new Headers({ accept: 'application/json' }),
      params: [{ kind: 'header', key: 'Accept', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['text/plain'])

    expect([...request.headers]).toEqual([['accept', 'application/json, text/plain']])
  })

  it('JSON-stringifies an object body', async () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/users',
      params: [{ kind: 'body', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([{ name: 'Ada' }])

    expect(request.body).toBe('{"name":"Ada"}')
  })

  it('passes a string body through untouched', async () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/raw',
      params: [{ kind: 'body', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['raw-text'])

    expect(request.body).toBe('raw-text')
  })

  // undici cannot send a URLSearchParams at all, so it leaves the builder as the string fetch would have sent, with
  // the label fetch would have given it.
  it('sends a URLSearchParams body as a labelled form string', () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/form',
      params: [{ kind: 'body', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([
      new URLSearchParams({ a: '1', b: 'x y' }),
    ])

    expect(request.body).toBe('a=1&b=x+y')
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8')
  })

  it('builds a form-url-encoded body from form-field parameters', async () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/form',
      formURLEncoded: true,
      params: [
        { kind: 'form-field', key: 'name', index: 0 },
        { kind: 'form-field', key: 'age', index: 1 },
      ],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['Ada', 30])

    expect(request.body).toBe('name=Ada&age=30')
  })

  it('binds a signal parameter', () => {
    const controller = new AbortController()
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      params: [{ kind: 'signal', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([controller.signal])

    expect(request.signal?.aborted).toBe(false)
    controller.abort()
    expect(request.signal?.aborted).toBe(true)
  })
})
