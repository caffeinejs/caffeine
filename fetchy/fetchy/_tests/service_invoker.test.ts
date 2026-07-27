import { describe, expect, it } from 'vitest'

import type { MethodSpec } from '../decorators/registrar/index.js'
import { JSONResponseConverter, RawResponseConverter } from '../response_converter.js'
import { buildInvoker } from '../service_invoker.js'
import { fakeJSONResponse, TestCall } from './test_call_factory.js'

function methodSpec(overrides: Partial<MethodSpec> = {}): MethodSpec {
  return {
    httpMethod: '',
    path: '',
    headers: new Headers(),
    params: [],
    formURLEncoded: false,
    requestType: undefined,
    responseConverter: undefined,
    requestBodyConverter: undefined,
    responseHandler: undefined,
    kind: 'method',
    callback: false,
    retry: undefined,
    noRetry: false,
    ...overrides,
  }
}

describe('buildInvoker', () => {
  it('runs the request through the interceptor chain and converts the JSON response', async () => {
    const meta = methodSpec({
      httpMethod: 'GET',
      path: '/users/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const call = new TestCall()
    call.willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const seen: string[] = []
    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        call,
        interceptors: [
          {
            intercept(chain) {
              seen.push(chain.request().url)
              return chain.proceed(chain.request())
            },
          },
        ],
        responseConverter: JSONResponseConverter,
        errorResponseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke('1')

    expect(result).toEqual({ id: '1', name: 'Ada' })
    expect(seen).toEqual(['http://example.test/users/1'])
    expect(call.lastRequest?.method).toBe('GET')
  })

  it('throws ErrFetchyHTTP on a non-ok response, with the parsed error body', async () => {
    const meta = methodSpec({
      httpMethod: 'GET',
      path: '/users/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const call = new TestCall()
    call.willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        call,
        interceptors: [],
        responseConverter: JSONResponseConverter,
        errorResponseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    await expect(invoke('404')).rejects.toMatchObject({
      name: 'ErrFetchyHTTP',
      status: 404,
      body: { message: 'not found' },
    })
  })

  it('supports a raw response converter that skips JSON parsing', async () => {
    const meta = methodSpec({ httpMethod: 'GET', path: '/raw' })

    const call = new TestCall()
    const response = fakeJSONResponse(200, { ignored: true })
    call.willRespond(response)

    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        call,
        interceptors: [],
        responseConverter: RawResponseConverter,
        errorResponseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke()

    expect(result).toBe(response)
  })
})
