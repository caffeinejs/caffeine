import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import type { Authenticator } from '../authenticator.js'
import { RetryInterceptor } from '../builtin/retry/index.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { Retry } from '../decorators/retry.js'
import { GET, POST, PUT } from '../decorators/verbs.js'
import { ErrFetchyTooManyAuthenticationAttempts } from '../errors.js'
import type { Interceptor, InterceptorFunction } from '../interceptor.js'
import { noop } from '../noop.js'
import type { FetchyRequest } from '../request.js'
import { RawRequestBodyConverter } from '../request_body_converter.js'
import type { FetchyResponse } from '../response.js'
import type { Transport } from '../transport.js'
import { fakeJSONResponse, TestTransportFactory } from './test_transport_factory.js'

interface User {
  id: string
}

@API('/users')
class UsersAPI {
  @GET('/{id}')
  @Params([Param('id')])
  getUser(_id: string): Promise<User> {
    return noop()
  }

  @POST('/')
  @Params([Body()])
  createUser(_user: unknown): Promise<User> {
    return noop()
  }

  @PUT('/{id}')
  @UseRequestBodyConverter(RawRequestBodyConverter)
  @Params([Param('id'), Body()])
  upload(_id: string, _content: unknown): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 1 })
  @Params([Param('id')])
  getUserWithRetry(_id: string): Promise<User> {
    return noop()
  }
}

function unauthorized(error = 'invalid_token'): Response {
  return fakeJSONResponse(401, { error }, 'Unauthorized')
}

function withToken(request: FetchyRequest, token: string): FetchyRequest {
  const followUp = request.clone()
  followUp.headers.set('authorization', `Bearer ${token}`)
  return followUp
}

// What an authenticator with fixed credentials does: it answers the first 401, and gives up once those are refused.
function answerOnce(attempts: number[] = []): Authenticator {
  return {
    authenticate(request, _response, attempt) {
      attempts.push(attempt)
      return Promise.resolve(attempt > 1 ? null : withToken(request, 'fresh'))
    },
  }
}

function buildClient(
  transportFactory: TestTransportFactory,
  authenticator: Authenticator,
  ...interceptors: (Interceptor | InterceptorFunction)[]
): UsersAPI {
  const builder = newClient()
    .baseURL('http://example.test')
    .transportFactory(transportFactory)
    .authenticator(authenticator)

  for (const interceptor of interceptors) {
    builder.addInterceptor(interceptor)
  }

  return builder.build().create(UsersAPI)
}

function webStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('content'))
      controller.close()
    },
  })
}

describe('Authenticator', () => {
  // A server that challenges before it accepts credentials is answered within the call: the caller gets the response
  // to the authenticated request, never the challenge.
  it('answers a 401 with the follow-up the authenticator returns', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce())
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(transport.sendCount).toBe(2)
    expect(transport.lastRequest?.headers.get('authorization')).toBe('Bearer fresh')
  })

  // Giving up leaves the challenge as the server sent it: the error carries the 401's body, which says why the
  // credentials were refused.
  it('ends the call with the 401 when the authenticator returns null', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, { authenticate: () => Promise.resolve(null) })
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized())

    await expect(api.getUser('1')).rejects.toMatchObject({
      name: 'ErrFetchyHTTP',
      status: 401,
      body: { error: 'invalid_token' },
    })
    expect(transport.sendCount).toBe(1)
  })

  // Wrong credentials stay wrong: counting attempts lets an authenticator stop after one try without keeping state per
  // call, and the caller sees the latest refusal.
  it('tells the authenticator which attempt the 401 answers', async () => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts))
    const transport = transportFactory.transports[0]
    const first = unauthorized('invalid_token')
    transport.willRespond(first).willRespond(unauthorized('insufficient_scope'))

    await expect(api.getUser('1')).rejects.toMatchObject({ status: 401, body: { error: 'insufficient_scope' } })
    expect(attempts).toEqual([1, 2])
    expect(transport.sendCount).toBe(2)
    expect(first.bodyUsed).toBe(true)
  })

  // An authenticator that never gives up would resend forever, each resend maybe costing the token endpoint a
  // refresh. The call fails instead, and leaves no 401 holding its connection.
  it('fails the call when the authenticator never gives up', async () => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, {
      authenticate(request, _response, attempt) {
        attempts.push(attempt)
        return Promise.resolve(request.clone())
      },
    })
    const transport = transportFactory.transports[0]
    const challenges = [unauthorized(), unauthorized(), unauthorized(), unauthorized()]

    for (const challenge of challenges) {
      transport.willRespond(challenge)
    }

    await expect(api.getUser('1')).rejects.toBeInstanceOf(ErrFetchyTooManyAuthenticationAttempts)
    expect(transport.sendCount).toBe(4)
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(challenges.every(challenge => challenge.bodyUsed)).toBe(true)
  })

  // The authenticator's failure explains the call's better than the 401 it could not answer, and an unread 401 would
  // keep its connection busy.
  it('fails the call with the error the authenticator throws', async () => {
    const failure = new Error('token endpoint unavailable')
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, { authenticate: () => Promise.reject(failure) })
    const transport = transportFactory.transports[0]
    const challenge = unauthorized()
    transport.willRespond(challenge)

    await expect(api.getUser('1')).rejects.toBe(failure)
    expect(challenge.bodyUsed).toBe(true)
    expect(transport.sendCount).toBe(1)
  })

  // An authenticator may read the challenge to decide. A body it read is locked, and cancelling it would throw.
  it('sends the follow-up after the authenticator read the 401 body', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, {
      async authenticate(request, response) {
        const { error } = (await response.json()) as { error: string }
        return error === 'invalid_token' ? withToken(request, 'fresh') : null
      },
    })
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(transport.sendCount).toBe(2)
  })

  // An authenticator may read part of the challenge and let go of it. What it left unread still holds the connection,
  // so it is cancelled before the follow-up goes out.
  it('cancels a 401 body the authenticator read in part', async () => {
    let cancelled = false
    const challenge = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"invalid_token"}'))
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 401, statusText: 'Unauthorized' },
    )
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, {
      async authenticate(request, response) {
        const reader = response.body!.getReader()
        await reader.read()
        reader.releaseLock()
        return withToken(request, 'fresh')
      },
    })
    const transport = transportFactory.transports[0]
    transport.willRespond(challenge).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(cancelled).toBe(true)
  })

  // Cancelling only frees what the 401 still holds. When the cancel fails, the follow-up still goes out: the call waits
  // for the answer, not for the 401's leftovers.
  it('sends the follow-up when cancelling the 401 fails', async () => {
    const challenge = new Response(
      new ReadableStream({
        cancel() {
          throw new Error('socket gone')
        },
      }),
      { status: 401, statusText: 'Unauthorized' },
    )
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce())
    const transport = transportFactory.transports[0]
    transport.willRespond(challenge).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(transport.sendCount).toBe(2)
  })

  // The first send read the stream, so a follow-up would send it empty. The authenticator is still asked, so it can
  // refresh credentials for the calls that follow.
  it('does not resend a body that can be read only once', async () => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts))
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.upload('1', webStream())).rejects.toMatchObject({ name: 'ErrFetchyHTTP', status: 401 })
    expect(transport.sendCount).toBe(1)
    expect(attempts).toEqual([1])
  })

  // A body held in memory is sent whole again, so an authenticated write is answered like any other call.
  it('resends a body held in memory', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce())
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.createUser({ name: 'Ada' })).resolves.toEqual({ id: '1' })
    expect(transport.sendCount).toBe(2)
    expect(transport.lastRequest?.body).toBe('{"name":"Ada"}')
  })

  // A 403 refuses credentials the server accepted, and a 407 asks for the proxy's, which the transport's dispatcher
  // holds: new request credentials answer neither.
  it.each([403, 407])('leaves a %i to the caller', async status => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts))
    transportFactory.transports[0].willRespond(fakeJSONResponse(status, { error: 'denied' }))

    await expect(api.getUser('1')).rejects.toMatchObject({ name: 'ErrFetchyHTTP', status })
    expect(attempts).toEqual([])
  })

  // Only interceptors put a token on the request, and a refresh has to know which one the server rejected. A follow-up
  // skips them, so an interceptor sees one request and the response that ends the call.
  it('runs between the interceptors and the transport', async () => {
    const rejected: (string | null)[] = []
    const statuses: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(
      transportFactory,
      {
        authenticate(request) {
          rejected.push(request.headers.get('authorization'))
          return Promise.resolve(withToken(request, 'fresh'))
        },
      },
      async chain => {
        chain.request().headers.set('authorization', 'Bearer stale')
        const response = await chain.proceed(chain.request())
        statuses.push(response.status)
        return response
      },
    )
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(rejected).toEqual(['Bearer stale'])
    expect(statuses).toEqual([200])
    expect(transport.lastRequest?.headers.get('authorization')).toBe('Bearer fresh')
  })

  // A retry is a new exchange built from the request the interceptors passed on, so its 401 is answered as the first,
  // not counted against the exchange that failed.
  it('starts over on each attempt of a retried call', async () => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts), RetryInterceptor.INSTANCE)
    const transport = transportFactory.transports[0]
    transport
      .willRespond(unauthorized())
      .willRespond(fakeJSONResponse(503, {}))
      .willRespond(unauthorized())
      .willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUserWithRetry('1')).resolves.toEqual({ id: '1' })
    expect(attempts).toEqual([1, 1])
    expect(transport.sendCount).toBe(4)
  })

  // A follow-up that cannot be sent fails the call as the transport reported it, so a retry above can still recognize a
  // transient failure.
  it('fails the call with the error the follow-up fails with', async () => {
    const failure = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce())
    const transport = transportFactory.transports[0]
    transport.willRespond(unauthorized()).willFail(failure)

    await expect(api.getUser('1')).rejects.toBe(failure)
    expect(transport.sendCount).toBe(2)
  })
})

// What an application writes for a token that expires: it refreshes only when the server rejected the token still
// current, and every call rejected meanwhile waits on that one refresh.
class TokenAuthenticator implements Authenticator {
  #refreshing: Promise<string> | undefined

  constructor(
    public token: string,
    private readonly fetchToken: () => Promise<string>,
  ) {}

  async authenticate(
    request: FetchyRequest,
    _response: FetchyResponse,
    attempt: number,
  ): Promise<FetchyRequest | null> {
    // Two tries: the token held, then a refreshed one.
    if (attempt > 2) {
      return null
    }

    if (request.headers.get('authorization') === `Bearer ${this.token}`) {
      this.#refreshing ??= this.fetchToken().finally(() => {
        this.#refreshing = undefined
      })
      this.token = await this.#refreshing
    }

    return withToken(request, this.token)
  }
}

// A server that accepts only its current token. It answers by header, since concurrent calls interleave, and holds
// `/users/late` until `released`, so that call's 401 arrives after the refresh.
function tokenServer(current: string, released: Promise<void>): Transport {
  return {
    async send(request) {
      if (request.path === '/users/late') {
        await released
      }

      return request.headers.get('authorization') === `Bearer ${current}`
        ? fakeJSONResponse(200, { id: request.path })
        : unauthorized()
    },
  }
}

describe('Authenticator refreshing a token', () => {
  // One expired token sends every call in flight to the authenticator at once. One refresh serves them all, and a call
  // whose 401 arrives after it reuses the new token instead of refreshing again.
  it.each([
    ['without interceptors', false],
    ['behind an interceptor that sets the token', true],
  ])('refreshes once for every rejected call, %s', async (_case, intercepted) => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    let refreshes = 0
    const authenticator = new TokenAuthenticator('token-1', async () => {
      refreshes++
      await delay(5)
      return 'token-2'
    })
    const builder = newClient()
      .baseURL('http://example.test')
      .transportFactory({ provide: () => tokenServer('token-2', released) })
      .authenticator(authenticator)

    if (intercepted) {
      builder.addInterceptor(chain => {
        chain.request().headers.set('authorization', `Bearer ${authenticator.token}`)
        return chain.proceed(chain.request())
      })
    }

    const api = builder.build().create(UsersAPI)
    const late = api.getUser('late')

    await expect(Promise.all([api.getUser('1'), api.getUser('2'), api.getUser('3')])).resolves.toEqual([
      { id: '/users/1' },
      { id: '/users/2' },
      { id: '/users/3' },
    ])
    release()

    await expect(late).resolves.toEqual({ id: '/users/late' })
    expect(refreshes).toBe(1)
  })
})
