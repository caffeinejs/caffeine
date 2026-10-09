import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import type { Authenticator } from '../authenticator.js'
import { RetryInterceptor } from '../builtin/retry/index.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { Retry } from '../decorators/retry.js'
import { GET, POST, PUT } from '../decorators/verbs.js'
import { ErrFetchyFollowUpNotSent, ErrFetchyTooManyAuthenticationAttempts } from '../errors.js'
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

  @GET('/{id}')
  @Params([Param('id'), SignalParam()])
  getUserWithSignal(_id: string, _signal: AbortSignal): Promise<User> {
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
  // credentials were refused. An authenticator written in JavaScript that returns nothing gives up the same way.
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('ends the call with the 401 when the authenticator returns %s', async (_name, nothing) => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, { authenticate: () => Promise.resolve(nothing as null) })
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
  // refresh. The call stops after 3 follow-ups instead, without asking for a 4th it would not send, and leaves no 401
  // holding its connection.
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
    expect(attempts).toEqual([1, 2, 3])
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

  // The first send read the stream, so a follow-up would send it empty. The call fails saying so, not with a 401 that
  // would pass for refused credentials. The authenticator is still asked, so what it refreshes serves the calls that
  // follow.
  it('fails the call when the follow-up body can be read only once', async () => {
    const attempts: number[] = []
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts))
    const transport = transportFactory.transports[0]
    const challenge = unauthorized()
    transport.willRespond(challenge)

    await expect(api.upload('1', webStream())).rejects.toBeInstanceOf(ErrFetchyFollowUpNotSent)
    expect(transport.sendCount).toBe(1)
    expect(attempts).toEqual([1])
    expect(challenge.bodyUsed).toBe(true)
  })

  // Credentials stay with the origin the call was made to. A follow-up built for another, from what a challenge said or
  // by mistake, is refused before it leaves.
  it('fails the call when the follow-up targets another origin', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, {
      authenticate(request) {
        const followUp = withToken(request, 'fresh')
        followUp.origin = 'https://elsewhere.test'
        return Promise.resolve(followUp)
      },
    })
    const transport = transportFactory.transports[0]
    const challenge = unauthorized()
    transport.willRespond(challenge)

    await expect(api.getUser('1')).rejects.toBeInstanceOf(ErrFetchyFollowUpNotSent)
    expect(transport.sendCount).toBe(1)
    expect(challenge.bodyUsed).toBe(true)
  })

  // A caller that aborted waits for nothing more. Once the authenticator returns, whatever it returned, the call rejects
  // with the abort reason rather than send a follow-up nobody waits for, or report the 401.
  it.each<[string, (request: FetchyRequest) => FetchyRequest | null]>([
    ['a follow-up', request => withToken(request, 'fresh')],
    ['null', () => null],
  ])('rejects with the abort reason when the call aborts while the authenticator returns %s', async (_name, answer) => {
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, {
      authenticate(request) {
        controller.abort(reason)
        return Promise.resolve(answer(request))
      },
    })
    const transport = transportFactory.transports[0]
    const challenge = unauthorized()
    transport.willRespond(challenge)

    await expect(api.getUserWithSignal('1', controller.signal)).rejects.toBe(reason)
    expect(transport.sendCount).toBe(1)
    expect(challenge.bodyUsed).toBe(true)
  })

  // A call aborted before its 401 is handled needs no credentials: the authenticator is not asked, so no refresh starts
  // for a caller that left.
  it('does not ask the authenticator about a call already aborted', async () => {
    const attempts: number[] = []
    const reason = new Error('caller gave up')
    const transportFactory = new TestTransportFactory()
    const api = buildClient(transportFactory, answerOnce(attempts))
    transportFactory.transports[0].willRespond(unauthorized())

    await expect(api.getUserWithSignal('1', AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(attempts).toEqual([])
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
  #refreshing: Promise<void> | undefined

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
      // Publishes the token and frees the slot in one step. A 401 handled between the two would find the slot free and
      // the old token still current, and start a second refresh.
      await (this.#refreshing ??= this.fetchToken().then(
        token => {
          this.token = token
          this.#refreshing = undefined
        },
        (error: unknown) => {
          this.#refreshing = undefined
          throw error
        },
      ))
    }

    return withToken(request, this.token)
  }
}

// A server that accepts only its current token. It answers by header, since concurrent calls interleave. It holds
// `/users/late` until `released`, and records the `authorization` each request for it carries in `late`.
function tokenServer(current: string, released: Promise<void>, late: (string | null)[]): Transport {
  return {
    async send(request) {
      if (request.path === '/users/late') {
        late.push(request.headers.get('authorization'))
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
  // whose 401 arrives while the refresh completes reuses the new token instead of refreshing again.
  it.each<[string, boolean, (string | null)[]]>([
    ['without interceptors', false, [null, 'Bearer token-2']],
    ['behind an interceptor that sets the token', true, ['Bearer token-1', 'Bearer token-2']],
  ])('refreshes once for every rejected call, %s', async (_case, intercepted, lateCarried) => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    const late: (string | null)[] = []
    let refreshes = 0
    const authenticator = new TokenAuthenticator('token-1', async () => {
      refreshes++
      await delay(5)
      // The held call's 401 then lands among the jobs that complete the refresh.
      release()
      return 'token-2'
    })
    const builder = newClient()
      .baseURL('http://example.test')
      .transportFactory({ provide: () => tokenServer('token-2', released, late) })
      .authenticator(authenticator)

    if (intercepted) {
      builder.addInterceptor(chain => {
        chain.request().headers.set('authorization', `Bearer ${authenticator.token}`)
        return chain.proceed(chain.request())
      })
    }

    const api = builder.build().create(UsersAPI)

    await expect(
      Promise.all([api.getUser('late'), api.getUser('1'), api.getUser('2'), api.getUser('3')]),
    ).resolves.toEqual([{ id: '/users/late' }, { id: '/users/1' }, { id: '/users/2' }, { id: '/users/3' }])
    expect(refreshes).toBe(1)
    expect(late).toEqual(lateCarried)
  })
})
