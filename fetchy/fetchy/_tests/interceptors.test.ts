import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Params } from '../decorators/params.js'
import { Param } from '../decorators/params/param.js'
import { GET } from '../decorators/verbs.js'
import type { Interceptor, InterceptorFunction } from '../interceptor.js'
import { Retry, RetryInterceptor } from '../retry/index.js'
import { fakeJSONResponse, TestTransportFactory } from '../test_transport_factory.testkit.js'

interface User {
  id: string
}

@API('/users')
class UsersAPI {
  @GET('/{id}')
  @Params([Param('id')])
  get!: (id: string) => Promise<User>

  @GET('/{id}')
  @Retry({ delay: 1 })
  @Params([Param('id')])
  getWithRetry!: (id: string) => Promise<User>
}

function clientWith(...interceptors: (Interceptor | InterceptorFunction)[]) {
  const transportFactory = new TestTransportFactory()
  const builder = newClient().baseURL('http://example.test').transportFactory(transportFactory)

  for (const interceptor of interceptors) {
    builder.addInterceptor(interceptor)
  }

  return { api: builder.build().create(UsersAPI), transport: transportFactory.transports[0] }
}

describe('interceptors', () => {
  // Interceptors wrap one another in the order they are added: the first sees the request first and the response
  // last, so a logger added first observes what every later interceptor did.
  it('run in the order they are added, the first outermost', async () => {
    const order: string[] = []
    const tracing =
      (name: string): InterceptorFunction =>
      async chain => {
        order.push(`${name} >`)
        const response = await chain.proceed(chain.request())
        order.push(`< ${name}`)
        return response
      }
    const { api, transport } = clientWith(tracing('first'), tracing('second'))
    transport.willRespond(fakeJSONResponse(200, { id: '1' }))

    await api.get('1')

    expect(order).toEqual(['first >', 'second >', '< second', '< first'])
  })

  // A cache or a stub answers from memory, and the request never reaches the network.
  it('can answer a call without the transport', async () => {
    const { api, transport } = clientWith(() => Promise.resolve(fakeJSONResponse(200, { id: 'cached' })))

    await expect(api.get('1')).resolves.toEqual({ id: 'cached' })
    expect(transport.sendCount).toBe(0)
  })

  // An interceptor may hand on a request of its own, such as a signed copy: that one is sent.
  it('send the request an interceptor hands on, not the one it was given', async () => {
    const { api, transport } = clientWith(chain => {
      const signed = chain.request().clone()
      signed.headers.set('x-signature', 'sig-1')
      signed.path = `${signed.path}?signed=1`
      return chain.proceed(signed)
    })
    transport.willRespond(fakeJSONResponse(200, { id: '1' }))

    await api.get('1')

    expect(transport.lastRequest?.headers.get('x-signature')).toBe('sig-1')
    expect(transport.lastRequest?.path).toBe('/users/1?signed=1')
  })

  // An interceptor that refuses a call, for an open circuit or a missing token, fails it with its own error, thrown
  // or rejected.
  it.each([
    [
      'throws',
      (refusal: Error): InterceptorFunction =>
        () => {
          throw refusal
        },
    ],
    [
      'rejects',
      (refusal: Error): InterceptorFunction =>
        () =>
          Promise.reject(refusal),
    ],
  ])('fail the call with the error an interceptor %s, and send nothing', async (_how, refusing) => {
    const refusal = new Error('circuit open')
    const { api, transport } = clientWith(refusing(refusal))

    await expect(api.get('1')).rejects.toBe(refusal)
    expect(transport.sendCount).toBe(0)
  })

  // RetryInterceptor runs every attempt inside its own intercept(). An interceptor added after it sees each attempt, as
  // a logger should; one added before it sees the call's one outcome, as a metric of calls should.
  it('see each attempt after RetryInterceptor, and the outcome alone before it', async () => {
    const before: number[] = []
    const after: number[] = []
    const statuses =
      (seen: number[]): InterceptorFunction =>
      async chain => {
        const response = await chain.proceed(chain.request())
        seen.push(response.status)
        return response
      }
    const { api, transport } = clientWith(statuses(before), RetryInterceptor.INSTANCE, statuses(after))
    transport.willRespond(fakeJSONResponse(503, {})).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getWithRetry('1')).resolves.toEqual({ id: '1' })
    expect(after).toEqual([503, 200])
    expect(before).toEqual([200])
  })
})
