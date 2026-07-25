import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
import { Params } from '../decorators/params.js'
import { Path } from '../decorators/path.js'
import { GET, POST } from '../decorators/verbs.js'
import { ErrFetchyEmptyClient, ErrFetchyHTTP, ErrFetchyInvalidRoute } from '../errors.js'
import { noop } from '../noop.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
  name: string
}

// A fresh class is declared per test rather than shared at module scope: a decorated method's
// built invoker lives on the class's own metadata (see client.ts), so reusing one class across
// multiple `client.create()` calls would make later tests silently reuse the first test's client.

describe('FetchyClient end-to-end (fake CallFactory)', () => {
  it('builds a request from decorators, dispatches it, and converts the JSON response', async () => {
    @Path('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id'), Query('active')])
      getUser(_id: string, _active: boolean): Promise<User> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
    const api = client.create(UsersAPI)

    const testCall = callFactory.calls[0]
    testCall.willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const user = await api.getUser('1', true)

    expect(testCall.lastRequest?.method).toBe('GET')
    expect(testCall.lastRequest?.url).toBe('http://example.test/users/1?active=true')
    expect(user).toEqual({ id: '1', name: 'Ada' })
  })

  it('POSTs a JSON body', async () => {
    @Path('/users')
    class UsersAPI {
      @POST('/')
      @Params([Body()])
      createUser(_body: { name: string }): Promise<User> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
    const api = client.create(UsersAPI)

    callFactory.calls[0].willRespond(fakeJSONResponse(201, { id: '2', name: 'Grace' }))

    const user = await api.createUser({ name: 'Grace' })

    expect(callFactory.calls[0].lastRequest?.method).toBe('POST')
    expect(callFactory.calls[0].lastRequest?.url).toBe('http://example.test/users/')
    await expect(callFactory.calls[0].lastRequest?.text()).resolves.toBe('{"name":"Grace"}')
    expect(user).toEqual({ id: '2', name: 'Grace' })
  })

  it('throws ErrFetchyHTTP on a non-ok response', async () => {
    @Path('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
    const api = client.create(UsersAPI)

    callFactory.calls[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    await expect(api.getUser('404')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('throws ErrFetchyEmptyClient for a class with no decorated methods', () => {
    class Empty {}

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Empty)).toThrow(ErrFetchyEmptyClient)
  })

  it('throws ErrFetchyInvalidRoute when a GET method declares a body parameter', () => {
    class Invalid {
      @GET('/x')
      @Params([Body()])
      bad(_body: unknown): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })

  it('throws ErrFetchyInvalidRoute when a path placeholder has no matching @Param', () => {
    class Invalid {
      @GET('/{id}')
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })
})
