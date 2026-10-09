import { describe, expect, it, vi } from 'vitest'

import { newClient } from '../client_builder.js'
import { Accept } from '../decorators/accept.js'
import { API } from '../decorators/api.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Multipart } from '../decorators/multipart.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Header } from '../decorators/params/header.js'
import { Param } from '../decorators/params/param.js'
import { Part } from '../decorators/params/part.js'
import { Query } from '../decorators/params/query.js'
import { QueryName } from '../decorators/params/query_name.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { DELETE, GET, POST } from '../decorators/verbs.js'
import {
  ErrFetchyClientNotBuilt,
  ErrFetchyEmptyClient,
  ErrFetchyHTTP,
  ErrFetchyInvalidRoute,
  ErrFetchyMissingAPIDecorator,
  ErrFetchyMissingPathArgument,
} from '../errors.js'
import { noop } from '../noop.js'
import { JSONRequestBodyConverter, MultipartRequestBodyConverter } from '../request_body_converter.js'
import { type ResponseConverter as ResponseConverterInstance, TextResponseConverter } from '../response_converter.js'
import type { Transport } from '../transport.js'
import { fakeJSONResponse, TestTransportFactory } from './test_transport_factory.js'

interface User {
  id: string
  name: string
}

describe('FetchyClient end-to-end (fake TransportFactory)', () => {
  it('builds a request from decorators, dispatches it, and converts the JSON response', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id'), Query('active')])
      getUser(_id: string, _active: boolean): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
    const api = client.create(UsersAPI)

    const testTransport = transportFactory.transports[0]
    testTransport.willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const user = await api.getUser('1', true)

    expect(testTransport.lastRequest?.method).toBe('GET')
    expect(testTransport.lastRequest?.url).toBe('http://example.test/users/1?active=true')
    expect(user).toEqual({ id: '1', name: 'Ada' })
  })

  it('dispatches a request for a field-declared operation', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser!: (id: string) => Promise<User>
    }

    const transportFactory = new TestTransportFactory()
    const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
    const api = client.create(UsersAPI)

    transportFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const user = await api.getUser('1')

    expect(transportFactory.transports[0].lastRequest?.url).toBe('http://example.test/users/1')
    expect(user).toEqual({ id: '1', name: 'Ada' })
  })

  it('POSTs a JSON body', async () => {
    @API('/users')
    class UsersAPI {
      @POST('/')
      @Params([Body()])
      createUser(_body: { name: string }): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
    const api = client.create(UsersAPI)

    transportFactory.transports[0].willRespond(fakeJSONResponse(201, { id: '2', name: 'Grace' }))

    const user = await api.createUser({ name: 'Grace' })

    expect(transportFactory.transports[0].lastRequest?.method).toBe('POST')
    expect(transportFactory.transports[0].lastRequest?.url).toBe('http://example.test/users/')
    expect(transportFactory.transports[0].lastRequest?.body).toBe('{"name":"Grace"}')
    expect(user).toEqual({ id: '2', name: 'Grace' })
  })

  it('throws ErrFetchyHTTP on a non-ok response', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
    const api = client.create(UsersAPI)

    transportFactory.transports[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    await expect(api.getUser('404')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('throws ErrFetchyEmptyClient for a class with no decorated methods', () => {
    @API()
    class Empty {}

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Empty)).toThrow(ErrFetchyEmptyClient)
    expect(() => client.create(Empty)).toThrow(
      'Cannot create client for "Empty": neither the class nor its base classes declare an operation',
    )
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

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })

  it('throws ErrFetchyInvalidRoute when a path placeholder has no matching @Param, naming the operation Class.member', () => {
    @API()
    class Invalid {
      @GET('/{id}')
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
    expect(() => client.create(Invalid)).toThrow('Invalid route configuration for method "Invalid.bad"')
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

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
  })

  // Each describes a request fetchy cannot build, so the client refuses it when it is built, before any call.
  it('throws ErrFetchyInvalidRoute for an operation with no HTTP verb', () => {
    @API()
    class Invalid {
      @Params([Query('q')])
      bad(_q: string): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": missing an HTTP verb decorator (@GET/@POST/etc)',
    )
  })

  it('throws ErrFetchyInvalidRoute for two @Body() parameters', () => {
    @API()
    class Invalid {
      @POST('/x')
      @Params([Body(), Body()])
      bad(_first: unknown, _second: unknown): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": more than one @Body() parameter is not allowed',
    )
  })

  it('throws ErrFetchyInvalidRoute for a @Field() without @FormURLEncoded()', () => {
    @API()
    class Invalid {
      @POST('/x')
      @Params([Field('name')])
      bad(_name: string): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": @Field() requires @FormURLEncoded() on the method or class',
    )
  })

  it('throws ErrFetchyInvalidRoute for a @Param() the path has no placeholder for', () => {
    @API()
    class Invalid {
      @GET('/users')
      @Params([Param('id')])
      bad(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": @Param("id") has no matching "{id}" placeholder in path "/users"',
    )
  })

  // A base URL is often written with a trailing slash. Joined to a path that starts with one, it must not double it.
  it('drops the trailing slash of a base URL', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test/v1/')
      .transportFactory(transportFactory)
      .build()
      .create(UsersAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.getUser('1')

    expect(transportFactory.transports[0].lastRequest!.url).toBe('http://example.test/v1/users/1')
  })

  // In a browser, fetch resolves a path against the page's origin, so a client without a base URL calls its own site.
  it('sends to the path alone when the client has no base URL', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = newClient().transportFactory(transportFactory).build().create(UsersAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.getUser('1')

    expect(transportFactory.transports[0].lastRequest!.url).toBe('/users/1')
  })

  it('converts every response with the client-wide converter where an operation names none', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/greeting')
      greet(): Promise<string> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test')
      .transportFactory(transportFactory)
      .responseConverter(TextResponseConverter)
      .build()
      .create(UsersAPI)
    transportFactory.transports[0].willRespond(new Response('hello'))

    await expect(api.greet()).resolves.toBe('hello')
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

    const transportFactory = new TestTransportFactory()
    const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
    const api = client.create(UsersAPI)

    transportFactory.transports[0].willRespond(new Response('hello', { status: 200 }))

    await expect(api.getGreeting()).resolves.toBe('HELLO')
  })

  it('wires each create() call independently, even for the same decorated class', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const firstFactory = new TestTransportFactory()
    const firstClient = newClient().baseURL('http://first.test').transportFactory(firstFactory).build()
    const firstAPI = firstClient.create(UsersAPI)

    const secondFactory = new TestTransportFactory()
    const secondClient = newClient().baseURL('http://second.test').transportFactory(secondFactory).build()
    const secondAPI = secondClient.create(UsersAPI)

    firstFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))
    secondFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await firstAPI.getUser('1')
    await secondAPI.getUser('1')

    expect(firstFactory.transports[0].lastRequest?.url).toBe('http://first.test/users/1')
    expect(secondFactory.transports[0].lastRequest?.url).toBe('http://second.test/users/1')
  })

  // A client is shaped like any instance of its class: methods stay on the prototype and fields are own enumerable
  // properties. All `create()` adds is one symbol-keyed property per operation, which nothing enumerates.
  it('keeps methods on the prototype and fields on the instance, as an ordinary class would', () => {
    @API()
    class UsersAPI {
      @GET('/method')
      listViaMethod(): Promise<unknown> {
        return noop()
      }

      @GET('/field')
      listViaField!: () => Promise<unknown>
    }

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()
    const api = client.create(UsersAPI)

    expect(Object.hasOwn(api, 'listViaMethod')).toBe(false)
    expect(api.listViaMethod).toBe(UsersAPI.prototype.listViaMethod)
    expect(Object.keys(api)).toEqual(['listViaField'])
    expect(Object.getOwnPropertySymbols(api)).toHaveLength(2)
  })

  // TC39 applies class decorators bottom-up, and nothing checks their order. `@API()` used to snapshot the class
  // configuration when it ran, so a `@HeaderMap` listed above it was dropped: requests went out without a header the
  // server needed.
  it('applies class decorators listed above @API()', async () => {
    @HeaderMap({ 'x-api-key': 'secret' })
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(UsersAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await api.getUser('1')

    expect(transportFactory.transports[0].lastRequest?.url).toBe('http://example.test/users/1')
    expect(transportFactory.transports[0].lastRequest?.headers.get('x-api-key')).toBe('secret')
  })

  // `/users/undefined` names a resource like any other path, so the call has to fail before anything is sent.
  it('rejects a call with a missing path argument before anything reaches the transport', async () => {
    @API('/users')
    class UsersAPI {
      @DELETE('/{id}')
      @Params([Param('id')])
      remove(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(UsersAPI)

    await expect(api.remove(undefined as never)).rejects.toBeInstanceOf(ErrFetchyMissingPathArgument)
    expect(transportFactory.transports[0].lastRequest).toBeNull()
  })

  // A constructor may open a connection or start a timer. `create()` used to run it and only then reject the class's
  // routes, so a class that could never become a client still did that work. A failed class is not remembered as
  // valid either: every `create()` rejects it.
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

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Invalid)).toThrow(ErrFetchyInvalidRoute)
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

    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    expect(() => client.create(Undecorated)).toThrow(ErrFetchyMissingAPIDecorator)
  })
})

describe('the request an operation builds', () => {
  @API('/search')
  @Accept('application/json')
  class SearchAPI {
    @GET('')
    @Params([Query('q'), QueryName(), QueryName()])
    search(_q: string, _flag: string | null, _other: string | null): Promise<unknown> {
      return noop()
    }

    @GET('')
    @Params([QueryName(), Query('tag')])
    flagged(_flag: string, _tags: string[]): Promise<unknown> {
      return noop()
    }

    @GET('')
    @Params([Query('tag'), Query('q')])
    tagged(_tags: string[], _q: string): Promise<unknown> {
      return noop()
    }

    @GET('/export')
    @Accept('text/csv')
    @Params([Header('x-trace'), SignalParam()])
    export(_trace: string | null, _signal: AbortSignal | null): Promise<unknown> {
      return noop()
    }

    @POST('/subscribers')
    @FormURLEncoded()
    @Params([Field('name'), Field('nick')])
    subscribe(_name: string, _nick: string | null): Promise<unknown> {
      return noop()
    }
  }

  function clientOf<T extends object>(TargetAPI: new () => T) {
    const transportFactory = new TestTransportFactory()
    const api = newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(TargetAPI)
    const transport = transportFactory.transports[0]
    transport.willRespond(fakeJSONResponse(200, {})).willRespond(fakeJSONResponse(200, {}))

    return { api, transport }
  }

  it('appends value-less query names wherever they sit, and leaves out an absent one', async () => {
    const { api, transport } = clientOf(SearchAPI)

    await api.search('ada', 'exact', null)
    expect(transport.lastRequest!.path).toBe('/search?q=ada&exact')

    await api.flagged('exact', ['math', 'history'])
    expect(transport.lastRequest!.path).toBe('/search?exact&tag=math&tag=history')
  })

  it('opens the query string with a repeated entry as with any other', async () => {
    const { api, transport } = clientOf(SearchAPI)

    await api.tagged(['math', 'history'], 'ada')

    expect(transport.lastRequest!.path).toBe('/search?tag=math&tag=history&q=ada')
  })

  // An optional argument left out is not sent, rather than sent as the text "null".
  it('leaves out a header, a form field or a signal given as null', async () => {
    const { api, transport } = clientOf(SearchAPI)

    await api.export(null, null)

    expect(transport.lastRequest!.headers.has('x-trace')).toBe(false)
    expect(transport.lastRequest!.signal).toBeUndefined()

    await api.subscribe('Ada', null)

    expect(transport.lastRequest!.body).toBe('name=Ada')
  })

  it("sends the accept header a method declares in place of its class's", async () => {
    const { api, transport } = clientOf(SearchAPI)

    await api.export('t-1', null)
    expect(transport.lastRequest!.headers.get('accept')).toBe('text/csv')

    await api.search('ada', null, null)
    expect(transport.lastRequest!.headers.get('accept')).toBe('application/json')
  })

  // Paths are written by hand, with or without their slashes; they still join into one path with single slashes.
  it('joins paths written without their leading slash or with a trailing one', async () => {
    @API('users/')
    class UsersAPI {
      @GET('active/')
      active(): Promise<unknown> {
        return noop()
      }
    }

    @API()
    class RootAPI {
      @GET('')
      root(): Promise<unknown> {
        return noop()
      }
    }

    const users = clientOf(UsersAPI)
    const root = clientOf(RootAPI)

    await users.api.active()
    await root.api.root()

    expect(users.transport.lastRequest!.url).toBe('http://example.test/users/active')
    expect(root.transport.lastRequest!.url).toBe('http://example.test/')
  })
})

describe('a client behaves like an instance of its class', () => {
  function clientAt(baseURL: string, transportFactory = new TestTransportFactory()) {
    return newClient().baseURL(baseURL).transportFactory(transportFactory).build()
  }

  // Every client shares one function per method, so a spy or a breakpoint on the class sees all of them, while each
  // client still sends through its own wiring.
  it('lets one spy on the prototype observe every client, each still reaching its own base URL', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const spy = vi.spyOn(UsersAPI.prototype, 'getUser')
    const first = new TestTransportFactory()
    const second = new TestTransportFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test', second).create(UsersAPI)
    first.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))
    second.transports[0].willRespond(fakeJSONResponse(200, { id: '2', name: 'Grace' }))

    await firstAPI.getUser('1')
    await secondAPI.getUser('2')

    expect(spy).toHaveBeenCalledTimes(2)
    expect(first.transports[0].lastRequest?.url).toBe('http://first.test/users/1')
    expect(second.transports[0].lastRequest?.url).toBe('http://second.test/users/2')
  })

  // A decorator that wraps an operation, for logging or timing, has to run. TC39 applies a method's decorators bottom
  // up but runs a field's initializers top down, so the wrapper composes when listed above a method's verb and below
  // a field's. In the other position the verb replaces what the wrapper returned.
  it('composes with a wrapping decorator above a method verb or below a field verb', async () => {
    const seen: string[] = []

    function logged<This, Args extends unknown[], Return>(
      method: (this: This, ...args: Args) => Return,
      context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
    ): (this: This, ...args: Args) => Return {
      return function (this: This, ...args: Args): Return {
        seen.push(String(context.name))
        return method.apply(this, args)
      }
    }

    function loggedField<This, Value>(
      _value: undefined,
      context: ClassFieldDecoratorContext<This, Value>,
    ): (operation: Value) => Value {
      return operation =>
        ((...args: unknown[]): unknown => {
          seen.push(String(context.name))
          return (operation as (...args: unknown[]) => unknown)(...args)
        }) as Value
    }

    @API('/users')
    class UsersAPI {
      @logged
      @GET('/a')
      wrappedMethod(): Promise<unknown> {
        return noop()
      }

      @GET('/b')
      @logged
      unwrappedMethod(): Promise<unknown> {
        return noop()
      }

      @GET('/c')
      @loggedField
      wrappedField!: () => Promise<unknown>

      @loggedField
      @GET('/d')
      unwrappedField!: () => Promise<unknown>
    }

    const transportFactory = new TestTransportFactory()
    const api = clientAt('http://example.test', transportFactory).create(UsersAPI)
    for (let i = 0; i < 4; i++) {
      transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))
    }

    await api.wrappedMethod()
    await api.unwrappedMethod()
    await api.wrappedField()
    await api.unwrappedField()

    expect(seen).toEqual(['wrappedMethod', 'wrappedField'])
  })

  // A method needs its client as `this`, as any method needs its instance. Without one there is nothing to send
  // through, and the call fails at once rather than in a promise a caller might not await.
  it('throws ErrFetchyClientNotBuilt synchronously for a method called detached from its client', () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const api = clientAt('http://example.test').create(UsersAPI)
    const getUser = api.getUser

    expect(() => getUser('1')).toThrow(ErrFetchyClientNotBuilt)
    expect(() => UsersAPI.prototype.getUser.call({}, '1')).toThrow(ErrFetchyClientNotBuilt)
  })

  it('runs the operation of the client a method is called on', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const first = new TestTransportFactory()
    const second = new TestTransportFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test', second).create(UsersAPI)
    second.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await firstAPI.getUser.call(secondAPI, '1')

    expect(first.transports[0].lastRequest).toBeNull()
    expect(second.transports[0].lastRequest?.url).toBe('http://second.test/users/1')
  })

  // A field operation is bound to its client, as an arrow-function field is bound to its instance.
  it('binds a field operation to its client, so it works destructured and each client has its own', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser!: (id: string) => Promise<User>
    }

    const first = new TestTransportFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test').create(UsersAPI)
    first.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const { getUser } = firstAPI
    await getUser('1')

    expect(first.transports[0].lastRequest?.url).toBe('http://first.test/users/1')
    expect(firstAPI.getUser).not.toBe(secondAPI.getUser)
  })

  // `create()` wires the client once its constructor has returned, so the constructor cannot call an operation yet.
  it('throws ErrFetchyClientNotBuilt for an operation called from the constructor', () => {
    @API('/users')
    class UsersAPI {
      constructor() {
        void this.ping()
      }

      @GET('/ping')
      ping(): Promise<unknown> {
        return noop()
      }
    }

    expect(() => clientAt('http://example.test').create(UsersAPI)).toThrow(ErrFetchyClientNotBuilt)
  })

  // di's AOP weave hands out a proxy that runs a method with the proxy as `this` and forwards every other read to the
  // client, receiver included. The operation has to reach its client through it.
  it('dispatches through a proxy that forwards reads to the client, as di AOP weaving does', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = clientAt('http://example.test', transportFactory).create(UsersAPI)
    const woven = new Proxy(api, { get: (target, key, receiver) => Reflect.get(target, key, receiver) })
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await expect(woven.getUser('1')).resolves.toEqual({ id: '1', name: 'Ada' })
  })

  // A class decorator may return a replacement class. The replacement is what the module exports and what `create()`
  // receives, and today's emitters give it the metadata the members wrote.
  it('builds a class replaced by a class decorator listed above @API()', async () => {
    function traced<C extends new (...args: any[]) => object>(Target: C, _context: ClassDecoratorContext<C>): C {
      return class extends Target {
        readonly traced = true
      }
    }

    @traced
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<User> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = clientAt('http://example.test', transportFactory).create(UsersAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1', name: 'Ada' })
    expect((api as UsersAPI & { traced?: boolean }).traced).toBe(true)
  })

  it('lets the TypeError through when the class freezes its instances', () => {
    @API('/users')
    class Frozen {
      constructor() {
        Object.freeze(this)
      }

      @GET('/x')
      x(): Promise<unknown> {
        return noop()
      }
    }

    expect(() => clientAt('http://example.test').create(Frozen)).toThrow(TypeError)
  })
})

describe('FetchyClient.close()', () => {
  function closingTransport(onClose: () => void): Transport {
    return {
      send: () => Promise.reject(new Error('no request expected')),
      close: () => {
        onClose()
        return Promise.resolve()
      },
    }
  }

  // A transport that owns connections, such as undici's pool, has to be told when the application is done with them,
  // and a shutdown path that closes twice must not close twice.
  it('closes the transport once, however many times it is called', async () => {
    let closes = 0
    const client = newClient()
      .baseURL('http://example.test')
      .transportFactory({ provide: () => closingTransport(() => closes++) })
      .build()

    const first = client.close()
    const second = client.close()
    await first

    expect(second).toBe(first)
    expect(closes).toBe(1)
  })

  it('resolves when the transport has nothing to release', async () => {
    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    await expect(client.close()).resolves.toBeUndefined()
  })

  // `await using client = newClient()...build()` calls this when the block ends.
  it('closes the transport through Symbol.asyncDispose', async () => {
    let closes = 0
    const client = newClient()
      .baseURL('http://example.test')
      .transportFactory({ provide: () => closingTransport(() => closes++) })
      .build()

    await client[Symbol.asyncDispose]()

    expect(closes).toBe(1)
  })

  // An authenticator wraps what operations send through, not what the client owns: the transport's connections still
  // have to be released.
  it('closes the transport when an authenticator is set', async () => {
    let closes = 0
    const client = newClient()
      .baseURL('http://example.test')
      .transportFactory({ provide: () => closingTransport(() => closes++) })
      .authenticator({ authenticate: () => Promise.resolve(null) })
      .build()

    await client.close()

    expect(closes).toBe(1)
  })
})

// Each is refused when the client is built, before any call: the request it describes cannot reach a server intact.
describe('the validation of a multipart operation', () => {
  function create(TargetAPI: new () => object): () => unknown {
    const client = newClient().baseURL('http://example.test').transportFactory(new TestTransportFactory()).build()

    return () => client.create(TargetAPI)
  }

  it('refuses a Part() without @Multipart()', () => {
    @API()
    class Invalid {
      @POST('/x')
      @Params([Part('file')])
      bad(_file: Blob): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": @Part() requires @Multipart() on the method or class',
    )
  })

  it('refuses @Body() and Part() on one method', () => {
    @API()
    class Invalid {
      @POST('/x')
      @Multipart()
      @Params([Body(), Part('file')])
      bad(_body: unknown, _file: Blob): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": @Body() and @Part() cannot be used on the same method',
    )
  })

  // A method cannot opt out of the encoding its class sets, so the two conflict wherever each one is declared.
  it('refuses @Multipart() and @FormURLEncoded() on one method, or one of them from its class', () => {
    @API()
    class OnMethod {
      @POST('/x')
      @Multipart()
      @FormURLEncoded()
      bad(): Promise<unknown> {
        return noop()
      }
    }

    @API()
    @FormURLEncoded()
    class FromClass {
      @POST('/x')
      @Multipart()
      bad(): Promise<unknown> {
        return noop()
      }
    }

    const reason =
      '@Multipart() and @FormURLEncoded() cannot both apply to one method, whether set on the method or its class'

    expect(create(OnMethod)).toThrow(`Invalid route configuration for method "OnMethod.bad": ${reason}`)
    expect(create(FromClass)).toThrow(`Invalid route configuration for method "FromClass.bad": ${reason}`)
  })

  // A part is a body like any other: fetch refuses a GET that has one, and undici would send it.
  it('refuses a Part() on a GET', () => {
    @API()
    class Invalid {
      @GET('/x')
      @Multipart()
      @Params([Part('file')])
      bad(_file: Blob): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": GET requests cannot have a body',
    )
  })

  // A body that is always multipart goes out under the boundary and the length the transport encodes it with, so a
  // content-type or content-length argument would be dropped on every call. Refused when the client is built, it cannot
  // go unnoticed.
  it.each(['Content-Type', 'Content-Length'])(
    'refuses a %s Header() with Part() parameters, however it is spelled',
    header => {
      @API()
      class Invalid {
        @POST('/x')
        @Multipart()
        @Params([Part('file'), Header(header)])
        bad(_file: Blob, _value: string): Promise<unknown> {
          return noop()
        }
      }

      expect(create(Invalid)).toThrow(
        `Invalid route configuration for method "Invalid.bad": @Header("${header}") cannot be used on a multipart body: the transport sets content-type and content-length when it encodes the parts`,
      )
    },
  )

  it('refuses a content-type Header() with a @Body() that MultipartRequestBodyConverter converts, flag or not', () => {
    @API()
    class Invalid {
      @POST('/x')
      @UseRequestBodyConverter(MultipartRequestBodyConverter)
      @Params([Body(), Header('content-type')])
      bad(_body: unknown, _contentType: string): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Invalid)).toThrow(
      'Invalid route configuration for method "Invalid.bad": @Header("content-type") cannot be used on a multipart body',
    )
  })

  // The converter listed above @Multipart() decides what the body is, and may well send it under a type of its own.
  it('allows a content-type Header() where another converter decides the body', () => {
    @API()
    class Valid {
      @POST('/x')
      @UseRequestBodyConverter(JSONRequestBodyConverter)
      @Multipart()
      @Params([Body(), Header('content-type')])
      send(_body: unknown, _contentType: string): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Valid)).not.toThrow()
  })

  // A class-level @Multipart() reaches every operation, a bodiless GET included, which has no boundary to protect.
  it('allows a content-type Header() on an operation with no body', () => {
    @API()
    @Multipart()
    class Valid {
      @GET('/x')
      @Params([Header('content-type')])
      read(_contentType: string): Promise<unknown> {
        return noop()
      }
    }

    expect(create(Valid)).not.toThrow()
  })
})
