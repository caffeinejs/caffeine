import { describe, expect, it } from 'vitest'

import { RetryInterceptor } from '../builtin/retry/index.js'
import { API } from '../decorators/api.js'
import { NoRetry } from '../decorators/no_retry.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { Params } from '../decorators/params.js'
import { Path } from '../decorators/path.js'
import { Retry } from '../decorators/retry.js'
import { GET, PUT } from '../decorators/verbs.js'
import { newClient } from '../client_builder.js'
import { ErrFetchyHTTP } from '../errors.js'
import { noop } from '../noop.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
}

@API()
@Path('/users')
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

@API()
@Path('/users')
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
    expect(await call.lastRequest?.clone().json()).toEqual({ name: 'Ada' })
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
