import { describe, expect, it } from 'vitest'

import { JsonResponseConverter, RawResponseConverter } from '../response_converter.js'
import { buildInvoker } from '../service_invoker.js'
import { MethodMeta } from '../metadata.js'
import { fakeJsonResponse, TestCall } from './test_call_factory.js'

describe('buildInvoker', () => {
  it('runs the request through the interceptor chain and converts the JSON response', async () => {
    const meta = new MethodMeta()
    meta.httpMethod = 'GET'
    meta.path = '/users/{id}'
    meta.params = [{ kind: 'path', key: 'id', index: 0 }]

    const call = new TestCall()
    call.willRespond(fakeJsonResponse(200, { id: '1', name: 'Ada' }))

    const seen: string[] = []
    const invoke = buildInvoker(
      {
        baseUrl: 'http://example.test',
        call,
        interceptors: [
          {
            intercept(chain) {
              seen.push(chain.request().url)
              return chain.proceed(chain.request())
            },
          },
        ],
        responseConverter: JsonResponseConverter,
        errorResponseConverter: JsonResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke('1')

    expect(result).toEqual({ id: '1', name: 'Ada' })
    expect(seen).toEqual(['http://example.test/users/1'])
    expect(call.lastRequest?.method).toBe('GET')
  })

  it('throws ErrFetchyHttp on a non-ok response, with the parsed error body', async () => {
    const meta = new MethodMeta()
    meta.httpMethod = 'GET'
    meta.path = '/users/{id}'
    meta.params = [{ kind: 'path', key: 'id', index: 0 }]

    const call = new TestCall()
    call.willRespond(fakeJsonResponse(404, { message: 'not found' }, 'Not Found'))

    const invoke = buildInvoker(
      {
        baseUrl: 'http://example.test',
        call,
        interceptors: [],
        responseConverter: JsonResponseConverter,
        errorResponseConverter: JsonResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    await expect(invoke('404')).rejects.toMatchObject({
      name: 'ErrFetchyHttp',
      status: 404,
      body: { message: 'not found' },
    })
  })

  it('supports a raw response converter that skips JSON parsing', async () => {
    const meta = new MethodMeta()
    meta.httpMethod = 'GET'
    meta.path = '/raw'

    const call = new TestCall()
    const response = fakeJsonResponse(200, { ignored: true })
    call.willRespond(response)

    const invoke = buildInvoker(
      {
        baseUrl: 'http://example.test',
        call,
        interceptors: [],
        responseConverter: RawResponseConverter,
        errorResponseConverter: JsonResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke()

    expect(result).toBe(response)
  })
})
