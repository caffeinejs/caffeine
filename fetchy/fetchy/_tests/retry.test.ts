import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { RetryInterceptor } from '../builtin/retry/index.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { NoRetry } from '../decorators/no_retry.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { Retry } from '../decorators/retry.js'
import { GET, POST, PUT } from '../decorators/verbs.js'
import { ErrFetchyHTTP } from '../errors.js'
import { noop } from '../noop.js'
import { RawRequestBodyConverter } from '../request_body_converter.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
}

@API('/users')
class RetryAPI {
  @GET('/{id}')
  @Retry({ delay: 5 })
  @Params([Param('id')])
  getUser(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Params([Param('id')])
  getUserNoRetryDecorator(_id: string): Promise<User> {
    return noop()
  }

  @PUT('/{id}')
  @Retry({ delay: 5 })
  @Params([Param('id'), Body()])
  putUser(_id: string, _body: unknown): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 5, methods: ['PUT'] })
  @Params([Param('id')])
  getUserWrongMethod(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 5, statusCodes: [404] })
  @Params([Param('id')])
  getUserWrongStatus(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 200 })
  @Params([Param('id'), SignalParam()])
  getUserSlow(_id: string, _signal: AbortSignal): Promise<User> {
    return noop()
  }
}

@API('/users')
@Retry({ delay: 5 })
class RetryClassDefaultAPI {
  @GET('/{id}')
  @Params([Param('id')])
  getUser(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ statusCodes: [404], delay: 5 })
  @Params([Param('id')])
  overwriteDefaults(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @NoRetry()
  @Params([Param('id')])
  noRetry(_id: string): Promise<User> {
    return noop()
  }
}

function buildClient(TargetAPI: new () => object, callFactory: TestCallFactory): any {
  const client = newClient()
    .baseURL('http://example.test')
    .callFactory(callFactory)
    .addInterceptor(RetryInterceptor.INSTANCE)
    .build()

  return client.create(TargetAPI)
}

describe('@Retry() / @NoRetry() / RetryInterceptor', () => {
  it('retries a failing response until it succeeds, per @Retry() defaults', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    const call = callFactory.calls[0]
    call
      .willRespond(fakeJSONResponse(500, { error: true }))
      .willRespond(fakeJSONResponse(500, { error: true }))
      .willRespond(fakeJSONResponse(200, { id: '1' }))

    const result = await api.getUser('1')

    expect(result).toEqual({ id: '1' })
  })

  it('does not retry a method without @Retry()', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true }))

    await expect(api.getUserNoRetryDecorator('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('resends an intact request body on a retried attempt', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    const call = callFactory.calls[0]
    call.willRespond(fakeJSONResponse(500, { error: true })).willRespond(fakeJSONResponse(200, { id: '1' }))

    const result = await api.putUser('1', { name: 'Ada' })

    expect(result).toEqual({ id: '1' })
    expect(JSON.parse(String(call.lastRequest?.body))).toEqual({ name: 'Ada' })
  })

  it('does not retry when the request method is not in the configured methods list', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true }))

    await expect(api.getUserWrongMethod('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('does not retry when the response status is not in the configured statusCodes list', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true }))

    await expect(api.getUserWrongStatus('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('rejects and stops retrying once the request is aborted during the delay', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true })).willRespond(fakeJSONResponse(200, {}))

    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('aborted')), 10)

    await expect(api.getUserSlow('1', controller.signal)).rejects.toThrow()
  })

  it('inherits the class-level @Retry() default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryClassDefaultAPI, callFactory)
    const call = callFactory.calls[0]
    call.willRespond(fakeJSONResponse(500, { error: true })).willRespond(fakeJSONResponse(200, { id: '1' }))

    const result = await api.getUser('1')

    expect(result).toEqual({ id: '1' })
  })

  it('a method-level @Retry() fully overrides the class-level default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryClassDefaultAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true }))

    await expect(api.overwriteDefaults('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('@NoRetry() cancels the inherited class-level default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(RetryClassDefaultAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { error: true }))

    await expect(api.noRetry('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })
})

@API('/users')
class NetworkRetryAPI {
  @GET('/{id}')
  @Retry({ delay: 1 })
  @Params([Param('id')])
  getUser(_id: string): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 1 })
  @Params([Param('id'), SignalParam()])
  getUserWithSignal(_id: string, _signal: AbortSignal): Promise<User> {
    return noop()
  }

  @POST('/')
  @Retry({ delay: 1 })
  @Params([Body()])
  createUser(_user: User): Promise<User> {
    return noop()
  }

  @GET('/{id}')
  @Retry({ delay: 1, errorCodes: [] })
  @Params([Param('id')])
  getUserWithoutNetworkRetry(_id: string): Promise<User> {
    return noop()
  }
}

// How each transport reports the same failure: `fetch` wraps it in a `TypeError`, undici's own API does not.
function fetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) })
}

function undiciFailure(code: string): Error {
  return Object.assign(new Error('other side closed'), { code })
}

describe('RetryInterceptor on network failures', () => {
  // A connection reset or refused on an idempotent request is the transient failure retrying exists for.
  it('retries a fetch failure whose cause carries a transient code, until it succeeds', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    call
      .willFail(fetchFailure('ECONNRESET'))
      .willFail(fetchFailure('ECONNREFUSED'))
      .willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(call.executions).toBe(3)
  })

  it('retries an undici failure that carries the code itself', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    call.willFail(undiciFailure('UND_ERR_SOCKET')).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })
    expect(call.executions).toBe(2)
  })

  // A POST may have reached the server before the connection dropped. Sending it again could apply it twice.
  it('does not retry a network failure of a POST', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    call.willFail(fetchFailure('ECONNRESET')).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.createUser({ id: '1' })).rejects.toBeInstanceOf(TypeError)
    expect(call.executions).toBe(1)
  })

  it('gives up after the attempt limit, with the last failure', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    const last = undiciFailure('ECONNRESET')
    call.willFail(undiciFailure('ECONNRESET')).willFail(undiciFailure('ECONNRESET')).willFail(last)

    await expect(api.getUser('1')).rejects.toBe(last)
    expect(call.executions).toBe(3)
  })

  // The caller has given up on the request, so nobody waits for another attempt.
  it('does not retry a request whose signal is aborted', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    const controller = new AbortController()
    controller.abort()
    call.willFail(fetchFailure('ECONNRESET')).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUserWithSignal('1', controller.signal)).rejects.toBeInstanceOf(TypeError)
    expect(call.executions).toBe(1)
  })

  it('does not retry network failures when errorCodes is empty', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    call.willFail(fetchFailure('ECONNRESET')).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUserWithoutNetworkRetry('1')).rejects.toBeInstanceOf(TypeError)
    expect(call.executions).toBe(1)
  })

  // An error without a code is no transport failure, more likely a bug in an interceptor, and a retry would hide it.
  it('does not retry an error that carries no code', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(NetworkRetryAPI, callFactory)
    const call = callFactory.calls[0]
    const bug = new Error('interceptor bug')
    call.willFail(bug).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.getUser('1')).rejects.toBe(bug)
    expect(call.executions).toBe(1)
  })
})

@API('/files')
class UploadAPI {
  @PUT('/{id}')
  @Retry({ delay: 1 })
  @UseRequestBodyConverter(RawRequestBodyConverter)
  @Params([Param('id'), Body()])
  upload(_id: string, _content: unknown): Promise<unknown> {
    return noop()
  }
}

const content = new TextEncoder().encode('content')

function webStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content)
      controller.close()
    },
  })
}

describe('RetryInterceptor on a body that can be read only once', () => {
  // Every attempt shares the one body, and the first may have read it. undici then sends what is left, which is
  // nothing, and a server answers 200 to the empty PUT: the retry would empty the resource and report success.
  it.each([
    ['a web ReadableStream', webStream],
    ['a Node Readable', (): unknown => Readable.from([content])],
    [
      'an async generator',
      (): unknown =>
        (async function* () {
          yield content
        })(),
    ],
  ])('does not retry a network failure when the body is %s', async (_kind, body) => {
    const callFactory = new TestCallFactory()
    const api = buildClient(UploadAPI, callFactory)
    const call = callFactory.calls[0]
    const failure = undiciFailure('UND_ERR_SOCKET')
    call.willFail(failure).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.upload('1', body())).rejects.toBe(failure)
    expect(call.executions).toBe(1)
  })

  it('does not retry a failing response when the body is a stream', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(UploadAPI, callFactory)
    const call = callFactory.calls[0]
    call.willRespond(fakeJSONResponse(500, { error: true })).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.upload('1', webStream())).rejects.toBeInstanceOf(ErrFetchyHTTP)
    expect(call.executions).toBe(1)
  })

  // Bytes held in memory are sent whole on every attempt, so they stay as retryable as a string.
  it('still retries a body held in memory', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(UploadAPI, callFactory)
    const call = callFactory.calls[0]
    call.willFail(undiciFailure('UND_ERR_SOCKET')).willRespond(fakeJSONResponse(200, { id: '1' }))

    await expect(api.upload('1', content)).resolves.toEqual({ id: '1' })
    expect(call.executions).toBe(2)
    expect(call.lastRequest?.body).toBe(content)
  })
})
