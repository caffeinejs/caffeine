import { describe, expect, it, vi } from 'vitest'

import { CallbackCallAdapterFactory } from '../builtin/callback/index.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Callback } from '../decorators/callback.js'
import { Params } from '../decorators/params.js'
import { Param } from '../decorators/params/param.js'
import { Path } from '../decorators/path.js'
import { GET } from '../decorators/verbs.js'
import { ErrFetchyHTTP, ErrFetchyMissingCallbackArgument } from '../errors.js'
import { noop } from '../noop.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
  name: string
}

type UserCallback = (error: Error | null, user: User | null) => void

function buildClient(callFactory: TestCallFactory) {
  @API()
  @Path('/users')
  class UsersAPI {
    @GET('/{id}')
    @Callback()
    @Params([Param('id')])
    getUser(_id: string, _callback: UserCallback): void {
      return noop()
    }

    @GET('/{id}')
    @Callback()
    @Params([Param('id')])
    getUserField!: (id: string, callback: UserCallback) => void
  }

  const client = newClient()
    .baseURL('http://example.test')
    .callFactory(callFactory)
    .addCallAdapterFactory(new CallbackCallAdapterFactory())
    .build()

  return client.create(UsersAPI)
}

describe('@Callback() / CallbackCallAdapterFactory', () => {
  it('resolves via the callback instead of a Promise', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const result = await new Promise<[Error | null, User | null]>(resolve => {
      api.getUser('1', (error, user) => resolve([error, user]))
    })

    expect(result).toEqual([null, { id: '1', name: 'Ada' }])
  })

  it('calls the callback with an ErrFetchyHTTP on a non-ok response', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const [error, user] = await new Promise<[Error | null, User | null]>(resolve => {
      api.getUser('404', (err, data) => resolve([err, data]))
    })

    expect(error).toBeInstanceOf(ErrFetchyHTTP)
    expect(user).toBeNull()
  })

  it('throws ErrFetchyMissingCallbackArgument when called without a trailing function', () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(callFactory)

    expect(() => (api.getUser as (id: string) => void)('1')).toThrow(ErrFetchyMissingCallbackArgument)
  })

  it('invokes a throwing callback exactly once', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    let calls = 0
    const throwingCallback: UserCallback = () => {
      calls++
      throw new Error('boom')
    }

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      api.getUser('1', throwingCallback)
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(calls).toBe(1)
    expect(unhandled).toHaveLength(1)
  })

  it('works identically for a field-declared operation', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const callback = vi.fn()
    api.getUserField('1', callback)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(callback).toHaveBeenCalledWith(null, { id: '1', name: 'Ada' })
  })
})
