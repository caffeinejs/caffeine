import { describe, expect, it } from 'vitest'

import type { MethodSpec } from '../decorators/registrar/index.js'
import { RequestBuilder } from '../request_builder.js'

function methodMeta(overrides: Partial<MethodSpec> = {}): MethodSpec {
  return {
    httpMethod: '',
    path: '',
    headers: new Headers(),
    params: [],
    bodyIndex: -1,
    argLen: 0,
    formURLEncoded: false,
    requestType: undefined,
    responseType: undefined,
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

  it('JSON-stringifies an object body', async () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/users',
      bodyIndex: 0,
      params: [{ kind: 'body', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([{ name: 'Ada' }])

    await expect(request.text()).resolves.toBe('{"name":"Ada"}')
  })

  it('passes a string body through untouched', async () => {
    const meta = methodMeta({
      httpMethod: 'POST',
      path: '/raw',
      bodyIndex: 0,
      params: [{ kind: 'body', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest(['raw-text'])

    await expect(request.text()).resolves.toBe('raw-text')
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

    await expect(request.text()).resolves.toBe('name=Ada&age=30')
  })

  it('binds a signal parameter', () => {
    const controller = new AbortController()
    const meta = methodMeta({
      httpMethod: 'GET',
      path: '/users',
      params: [{ kind: 'signal', index: 0 }],
    })

    const request = new RequestBuilder('http://example.test', meta).toRequest([controller.signal])

    expect(request.signal.aborted).toBe(false)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })
})
