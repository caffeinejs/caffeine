import { describe, expect, it, vi } from 'vitest'

import type { Call } from '../call.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
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
import type { ResponseConverter as ResponseConverterInstance } from '../response_converter.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
  name: string
}

describe('FetchyClient end-to-end (fake CallFactory)', () => {
  it('builds a request from decorators, dispatches it, and converts the JSON response', async () => {
    @API('/users')
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
    @API('/users')
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
    @API('/users')
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
    @API('/users')
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

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

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

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

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
    @API('/users')
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

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()
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

    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(UsersAPI)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await api.getUser('1')

    expect(callFactory.calls[0].lastRequest?.url).toBe('http://example.test/users/1')
    expect(callFactory.calls[0].lastRequest?.headers.get('x-api-key')).toBe('secret')
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

    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(UsersAPI)

    await expect(api.remove(undefined as never)).rejects.toBeInstanceOf(ErrFetchyMissingPathArgument)
    expect(callFactory.calls[0].lastRequest).toBeNull()
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

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

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

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Undecorated)).toThrow(ErrFetchyMissingAPIDecorator)
  })
})

describe('a client behaves like an instance of its class', () => {
  function clientAt(baseURL: string, callFactory = new TestCallFactory()) {
    return newClient().baseURL(baseURL).callFactory(callFactory).build()
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
    const first = new TestCallFactory()
    const second = new TestCallFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test', second).create(UsersAPI)
    first.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))
    second.calls[0].willRespond(fakeJSONResponse(200, { id: '2', name: 'Grace' }))

    await firstAPI.getUser('1')
    await secondAPI.getUser('2')

    expect(spy).toHaveBeenCalledTimes(2)
    expect(first.calls[0].lastRequest?.url).toBe('http://first.test/users/1')
    expect(second.calls[0].lastRequest?.url).toBe('http://second.test/users/2')
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

    const callFactory = new TestCallFactory()
    const api = clientAt('http://example.test', callFactory).create(UsersAPI)
    for (let i = 0; i < 4; i++) {
      callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))
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

    const first = new TestCallFactory()
    const second = new TestCallFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test', second).create(UsersAPI)
    second.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    await firstAPI.getUser.call(secondAPI, '1')

    expect(first.calls[0].lastRequest).toBeNull()
    expect(second.calls[0].lastRequest?.url).toBe('http://second.test/users/1')
  })

  // A field operation is bound to its client, as an arrow-function field is bound to its instance.
  it('binds a field operation to its client, so it works destructured and each client has its own', async () => {
    @API('/users')
    class UsersAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser!: (id: string) => Promise<User>
    }

    const first = new TestCallFactory()
    const firstAPI = clientAt('http://first.test', first).create(UsersAPI)
    const secondAPI = clientAt('http://second.test').create(UsersAPI)
    first.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

    const { getUser } = firstAPI
    await getUser('1')

    expect(first.calls[0].lastRequest?.url).toBe('http://first.test/users/1')
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

    const callFactory = new TestCallFactory()
    const api = clientAt('http://example.test', callFactory).create(UsersAPI)
    const woven = new Proxy(api, { get: (target, key, receiver) => Reflect.get(target, key, receiver) })
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

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

    const callFactory = new TestCallFactory()
    const api = clientAt('http://example.test', callFactory).create(UsersAPI)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1', name: 'Ada' }))

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
  function closingCall(onClose: () => void): Call {
    return {
      execute: () => Promise.reject(new Error('no request expected')),
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
      .callFactory({ provide: () => closingCall(() => closes++) })
      .build()

    const first = client.close()
    const second = client.close()
    await first

    expect(second).toBe(first)
    expect(closes).toBe(1)
  })

  it('resolves when the transport has nothing to release', async () => {
    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    await expect(client.close()).resolves.toBeUndefined()
  })

  // `await using client = newClient()...build()` calls this when the block ends.
  it('closes the transport through Symbol.asyncDispose', async () => {
    let closes = 0
    const client = newClient()
      .baseURL('http://example.test')
      .callFactory({ provide: () => closingCall(() => closes++) })
      .build()

    await client[Symbol.asyncDispose]()

    expect(closes).toBe(1)
  })
})
