import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
import { Path } from '../decorators/path.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { DELETE, GET, POST } from '../decorators/verbs.js'
import {
  ErrFetchyEmptyClient,
  ErrFetchyHTTP,
  ErrFetchyInvalidRoute,
  ErrFetchyMissingAPIDecorator,
  ErrFetchyMissingPathArgument,
} from '../errors.js'
import { noop } from '../noop.js'
import type { ResponseConverter as ResponseConverterInstance } from '../response_converter.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
  name: string
}

describe('FetchyClient end-to-end (fake CallFactory)', () => {
  it('builds a request from decorators, dispatches it, and converts the JSON response', async () => {
    @API()
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

  it('dispatches a request for a field-declared operation', async () => {
    @API()
    @Path('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser!: (id: string) => Promise<User>
    }

    const callFactory = new TestCallFactory()
    const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
    const api = client.create(UsersAPI)

    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const user = await api.getUser('1')

    expect(callFactory.calls[0].lastRequest?.url).toBe('http://example.test/users/1')
    expect(user).toEqual({ id: '1', name: 'Ada' })
  })

  it('POSTs a JSON body', async () => {
    @API()
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
    expect(callFactory.calls[0].lastRequest?.body).toBe('{"name":"Grace"}')
    expect(user).toEqual({ id: '2', name: 'Grace' })
  })

  it('throws ErrFetchyHTTP on a non-ok response', async () => {
    @API()
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
    @API()
    class Empty {}

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Empty)).toThrow(ErrFetchyEmptyClient)
  })

  it('throws ErrFetchyInvalidRoute when a GET method declares a body parameter', () => {
    @API()
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
    @API()
    class Invalid {
      @GET('/{id}')
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })

  it('throws ErrFetchyInvalidRoute when @Body() and @Field() are used on the same method', () => {
    @API()
    class Invalid {
      @POST('/x')
      @FormURLEncoded()
      @Params([Body(), Field('name')])
      bad(_body: unknown, _name: string): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })

  it('@ResponseConverter overrides the converter for that method, ahead of the client-wide default', async () => {
    const upper: ResponseConverterInstance = {
      async convert(response) {
        return (await response.text()).toUpperCase()
      },
    }

    @API()
    class UsersAPI {
      @GET('/greeting')
      @UseResponseConverter(upper)
      getGreeting(): Promise<string> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
    const api = client.create(UsersAPI)

    callFactory.calls[0].willRespond(new Response('hello', { status: 200 }))

    await expect(api.getGreeting()).resolves.toBe('HELLO')
  })

  it('wires each create() call independently, even for the same decorated class', async () => {
    @API()
    @Path('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const firstFactory = new TestCallFactory()
    const firstClient = newClient().baseURL('http://first.test').callFactory(firstFactory).build()
    const firstAPI = firstClient.create(UsersAPI)

    const secondFactory = new TestCallFactory()
    const secondClient = newClient().baseURL('http://second.test').callFactory(secondFactory).build()
    const secondAPI = secondClient.create(UsersAPI)

    firstFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))
    secondFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await firstAPI.getUser('1')
    await secondAPI.getUser('1')

    expect(firstFactory.calls[0].lastRequest?.url).toBe('http://first.test/users/1')
    expect(secondFactory.calls[0].lastRequest?.url).toBe('http://second.test/users/1')
  })

  it("wires operations via defineProperty, preserving each one's original enumerability", () => {
    @API()
    class UsersAPI {
      @GET('/method')
      listViaMethod(): Promise<unknown> {
        return noop()
      }

      @GET('/field')
      listViaField!: () => Promise<unknown>
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()
    const api = client.create(UsersAPI)

    expect(Object.getOwnPropertyDescriptor(api, 'listViaMethod')?.enumerable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(api, 'listViaField')?.enumerable).toBe(true)
    expect(Object.keys(api)).toEqual(['listViaField'])
  })

  // TC39 applies class decorators bottom-up, and nothing checks their order. `@API()` used to snapshot the class
  // configuration when it ran, so a `@Path` or `@HeaderMap` listed above it was dropped: requests went to the wrong
  // URL, without a header the server needed.
  it('applies class decorators listed above @API()', async () => {
    @Path('/users')
    @HeaderMap({ 'x-api-key': 'secret' })
    @API()
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(UsersAPI)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await api.getUser('1')

    expect(callFactory.calls[0].lastRequest?.url).toBe('http://example.test/users/1')
    expect(callFactory.calls[0].lastRequest?.headers.get('x-api-key')).toBe('secret')
  })

  // `/users/undefined` names a resource like any other path, so the call has to fail before anything is sent.
  it('rejects a call with a missing path argument before anything reaches the transport', async () => {
    @API()
    @Path('/users')
    class UsersAPI {
      @DELETE('/{id}')
      @Params([Param('id')])
      remove(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(UsersAPI)

    await expect(api.remove(undefined as never)).rejects.toBeInstanceOf(ErrFetchyMissingPathArgument)
    expect(callFactory.calls[0].lastRequest).toBeNull()
  })

  // A constructor may open a connection or start a timer. `create()` used to run it and only then reject the class's
  // routes, so a class that could never become a client still did that work.
  it('does not run the constructor of a class whose route is invalid', () => {
    let constructed = 0

    @API()
    class Invalid {
      constructor() {
        constructed++
      }

      @GET('/{id}')
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
    expect(constructed).toBe(0)
  })

  it('throws ErrFetchyMissingAPIDecorator for a class never decorated with @API()', () => {
    class Undecorated {
      @GET('/x')
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Undecorated)).toThrow(ErrFetchyMissingAPIDecorator)
  })
})
