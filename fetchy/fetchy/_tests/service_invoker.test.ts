import { describe, expect, it } from 'vitest'

import type { MethodSpec } from '../decorators/registrar/index.js'
import { ErrFetchyInvalidRoute } from '../errors.js'
import { JSONResponseConverter, RawResponseConverter } from '../response_converter.js'
import { buildInvoker } from '../service_invoker.js'
import { fakeJSONResponse, TestTransport } from './test_transport_factory.js'

function methodSpec(overrides: Partial<MethodSpec> = {}): MethodSpec {
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

describe('buildInvoker', () => {
  it('runs the request through the interceptor chain and converts the JSON response', async () => {
    const meta = methodSpec({
      httpMethod: 'GET',
      path: '/users/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const transport = new TestTransport()
    transport.willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const seen: string[] = []
    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        transport,
        interceptors: [
          {
            intercept(chain) {
              seen.push(chain.request().url)
              return chain.proceed(chain.request())
            },
          },
        ],
        responseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke(['1'])

    expect(result).toEqual({ id: '1', name: 'Ada' })
    expect(seen).toEqual(['http://example.test/users/1'])
    expect(transport.lastRequest?.method).toBe('GET')
  })

  it('throws ErrFetchyHTTP on a non-ok response, with the parsed error body', async () => {
    const meta = methodSpec({
      httpMethod: 'GET',
      path: '/users/{id}',
      params: [{ kind: 'path', key: 'id', index: 0 }],
    })

    const transport = new TestTransport()
    transport.willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        transport,
        interceptors: [],
        responseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    await expect(invoke(['404'])).rejects.toMatchObject({
      name: 'ErrFetchyHTTP',
      status: 404,
      body: { message: 'not found' },
    })
  })

  it('supports a raw response converter that skips JSON parsing', async () => {
    const meta = methodSpec({ httpMethod: 'GET', path: '/raw' })

    const transport = new TestTransport()
    const response = fakeJSONResponse(200, { ignored: true })
    transport.willRespond(response)

    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        transport,
        interceptors: [],
        responseConverter: RawResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    const result = await invoke([])

    expect(result).toBe(response)
  })

  // The invoker skips the default handler for an ok response, which it would hand back untouched. A handler the
  // operation names may replace an ok response, so it always runs.
  it('runs a custom response handler for an ok response too', async () => {
    const transport = new TestTransport()
    transport.willRespond(fakeJSONResponse(200, { original: true }))

    const statuses: number[] = []
    const meta = methodSpec({
      httpMethod: 'GET',
      path: '/x',
      responseHandler: {
        handle(_request, response) {
          statuses.push(response.status)
          return Promise.resolve(fakeJSONResponse(200, { replaced: true }))
        },
      },
    })

    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        transport,
        interceptors: [],
        responseConverter: JSONResponseConverter,
        callAdapterFactories: [],
      },
      meta,
    )

    await expect(invoke([])).resolves.toEqual({ replaced: true })
    expect(statuses).toEqual([200])
  })

  // A client stores one array-taking invoker per operation, while an adapter is written against a function that takes
  // the call's arguments one by one. The bridge has to hand both sides the arguments as the caller passed them.
  it('bridges a call adapter: it receives the arguments one by one and its function is what the call runs', async () => {
    const meta = methodSpec({ httpMethod: 'GET', path: '/users/{id}', params: [{ kind: 'path', key: 'id', index: 0 }] })

    const transport = new TestTransport()
    transport.willRespond(fakeJSONResponse(200, { id: '7' }))

    const received: unknown[][] = []
    const invoke = buildInvoker(
      {
        baseURL: 'http://example.test',
        transport,
        interceptors: [],
        responseConverter: JSONResponseConverter,
        callAdapterFactories: [
          {
            provide: () => ({
              adapt:
                invoker =>
                (...args: unknown[]) => {
                  received.push(args)
                  return invoker(...args).then(user => ({ adapted: user }))
                },
            }),
          },
        ],
      },
      meta,
    )

    await expect(invoke(['7', 'extra'])).resolves.toEqual({ adapted: { id: '7' } })
    expect(received).toEqual([['7', 'extra']])
    expect(transport.lastRequest?.url).toBe('http://example.test/users/7')
  })

  // An adapter that returns anything but a function would otherwise fail on the first call, far from the cause.
  it('rejects a call adapter that does not return a function when the invoker is built', () => {
    const meta = methodSpec({ httpMethod: 'GET', path: '/x' })

    expect(() =>
      buildInvoker(
        {
          baseURL: 'http://example.test',
          transport: new TestTransport(),
          interceptors: [],
          responseConverter: JSONResponseConverter,
          callAdapterFactories: [{ provide: () => ({ adapt: () => 42 as never }) }],
        },
        meta,
        'UsersAPI.op',
      ),
    ).toThrow(new ErrFetchyInvalidRoute('UsersAPI.op', 'its call adapter did not return a function'))
  })
})
