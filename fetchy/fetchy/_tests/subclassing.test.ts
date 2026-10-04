import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Params } from '../decorators/params.js'
import { Field } from '../decorators/params/field.js'
import { Param } from '../decorators/params/param.js'
import type { MethodSpec } from '../decorators/registrar/index.js'
import { getMethodBuilders } from '../decorators/registrar/registrar.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { Retry } from '../decorators/retry.js'
import { GET, POST } from '../decorators/verbs.js'
import { ErrFetchyInvalidRoute } from '../errors.js'
import { noop } from '../noop.js'
import type { FetchyRequest } from '../request.js'
import type { ResponseConverter } from '../response_converter.js'
import { captureMetadata } from './capture_metadata.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

interface User {
  id: string
}

// Builds a client of `TargetAPI` whose transport answers `responses` in order and records what each call sent, along
// with the operation configuration every call reached the interceptors with.
function clientOf<T extends object>(TargetAPI: new () => T, responses = 1) {
  const callFactory = new TestCallFactory()
  const metas: MethodSpec[] = []
  const api = newClient()
    .baseURL('http://example.test')
    .callFactory(callFactory)
    .addInterceptor(chain => {
      metas.push(chain.meta())
      return chain.proceed(chain.request())
    })
    .build()
    .create(TargetAPI)

  for (let i = 0; i < responses; i++) {
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: String(i) }))
  }

  const sent = (): FetchyRequest | null => callFactory.calls[0].lastRequest

  return { api, sent, metas }
}

describe('subclassing', () => {
  it("keeps each class's registry to the members the class itself declares", () => {
    const base = captureMetadata()
    const child = captureMetadata()

    @base.capture
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    @child.capture
    class Child extends Base {
      @GET('/child')
      child(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(base.metadata())
    const childMethods = getMethodBuilders(child.metadata())

    expect(baseMethods.has('base')).toBe(true)
    expect(childMethods.has('child')).toBe(true)
    expect(childMethods.has('base')).toBe(false)
  })

  it("never lets a subclass's members leak into or change its parent's registry", () => {
    const base = captureMetadata()
    const child = captureMetadata()

    @base.capture
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    @child.capture
    class Child extends Base {
      @GET('/base/override')
      base2(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(base.metadata())
    const childMethods = getMethodBuilders(child.metadata())

    expect(baseMethods.get('base')?.toMethodSpec().path).toBe('/base')
    expect(baseMethods.has('base2')).toBe(false)
    expect(childMethods.get('base2')?.toMethodSpec().path).toBe('/base/override')
  })
})

describe('subclassing through create()', () => {
  // A subclass that only adds behavior must still be a client: ordinary class inheritance, with no decorator of its own.
  it('serves an inherited operation on a subclass that has no decorators', async () => {
    @API('/users')
    class Base {
      @GET('/{id}')
      @Params([Param('id')])
      get(_id: string): Promise<User> {
        return noop()
      }
    }

    class Child extends Base {}

    const { api, sent } = clientOf(Child)
    await api.get('1')

    expect(sent()?.url).toBe('http://example.test/users/1')
  })

  // One effective configuration serves every operation the client reaches, `super` included: the subclass re-roots
  // what it inherits.
  it("sends an inherited operation under the subclass's path, called directly or through super", async () => {
    @API('/v1')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API('/v2')
    class Child extends Base {
      viaSuper(): Promise<unknown> {
        return super.a()
      }
    }

    const { api, sent } = clientOf(Child, 2)

    await api.a()
    expect(sent()?.url).toBe('http://example.test/v2/a')

    await api.viaSuper()
    expect(sent()?.url).toBe('http://example.test/v2/a')
  })

  // Redeclaring a member declares a second operation. The child's call and `super` must each reach their own, or an
  // override that decorates the parent's result would call itself.
  it("runs the child's route for a redeclared operation, and the parent's through super", async () => {
    @API('/users')
    class Base {
      @GET('/{id}')
      @Params([Param('id')])
      get(_id: string): Promise<User> {
        return noop()
      }
    }

    @API('/users')
    class Child extends Base {
      @GET('/{id}/full')
      @Params([Param('id')])
      override get(_id: string): Promise<User> {
        return noop()
      }

      parentGet(id: string): Promise<User> {
        return super.get(id)
      }
    }

    const { api, sent } = clientOf(Child, 2)

    await api.get('1')
    expect(sent()?.url).toBe('http://example.test/users/1/full')

    await api.parentGet('1')
    expect(sent()?.url).toBe('http://example.test/users/1')
  })

  // An override that declares no operation is an ordinary override. It runs in place of the inherited operation and
  // still reaches it through `super`, which is how a subclass works on what the operation returns.
  it('runs an undecorated override in place of the inherited operation, which it reaches through super', async () => {
    @API('/users')
    class Base {
      @GET('/{id}')
      @Params([Param('id')])
      get(_id: string): Promise<User> {
        return noop()
      }
    }

    class Child extends Base {
      override async get(id: string): Promise<User & { viaChild: boolean }> {
        return { ...(await super.get(id)), viaChild: true }
      }
    }

    const { api, sent, metas } = clientOf(Child)

    await expect(api.get('1')).resolves.toEqual({ id: '0', viaChild: true })
    expect(metas).toHaveLength(1)
    expect(sent()?.url).toBe('http://example.test/users/1')
  })

  it('builds a subclass that declares no operation of its own', async () => {
    @API('/users')
    class Base {
      @GET('/{id}')
      @Params([Param('id')])
      get(_id: string): Promise<User> {
        return noop()
      }
    }

    @API('/admins')
    class Admins extends Base {}

    const { api, sent } = clientOf(Admins)
    await api.get('1')

    expect(sent()?.url).toBe('http://example.test/admins/1')
  })

  // The case inheritance exists for: one generic base class, re-rooted by each API that extends it.
  it('re-roots a generic base class that carries no @API() of its own', async () => {
    abstract class Crud<T> {
      @GET('/{id}')
      @Params([Param('id')])
      get(_id: string): Promise<T> {
        return noop()
      }
    }

    @API('/users')
    class UsersAPI extends Crud<User> {}

    @API('/orders')
    class OrdersAPI extends Crud<{ id: string }> {}

    const users = clientOf(UsersAPI)
    const orders = clientOf(OrdersAPI)
    await users.api.get('1')
    await orders.api.get('2')

    expect(users.sent()?.url).toBe('http://example.test/users/1')
    expect(orders.sent()?.url).toBe('http://example.test/orders/2')
  })

  // SWC, which runs these tests, links no metadata for a subclass with only member decorators, and tsc does.
  it('accepts @API() on a base class only, for a subclass that declares operations of its own', async () => {
    @API('/users')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    class Child extends Base {
      @GET('/b')
      b(): Promise<unknown> {
        return noop()
      }
    }

    const { api, sent } = clientOf(Child, 2)

    await api.a()
    expect(sent()?.url).toBe('http://example.test/users/a')

    await api.b()
    expect(sent()?.url).toBe('http://example.test/users/b')
  })

  it("clears an inherited path with @API(''), and keeps it with @API()", async () => {
    @API('/users')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API('')
    class Cleared extends Base {}

    @API()
    class Kept extends Base {}

    const cleared = clientOf(Cleared)
    const kept = clientOf(Kept)
    await cleared.api.a()
    await kept.api.a()

    expect(cleared.sent()?.url).toBe('http://example.test/a')
    expect(kept.sent()?.url).toBe('http://example.test/users/a')
  })

  it('merges class headers by name, case-insensitively, the subclass winning', async () => {
    @API('/users')
    @HeaderMap({ 'X-Version': '1', 'x-base': 'yes' })
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API()
    @HeaderMap({ 'x-version': '2' })
    class Child extends Base {}

    const { api, sent } = clientOf(Child)
    await api.a()

    expect(sent()?.headers.get('x-version')).toBe('2')
    expect(sent()?.headers.get('x-base')).toBe('yes')
  })

  it("replaces the base class's converter and @Retry() with the subclass's, as a whole", async () => {
    const tagged = (tag: string): ResponseConverter => ({
      async convert(response) {
        return { tag, body: await response.json() }
      },
    })

    @API('/users')
    @UseResponseConverter(tagged('base'))
    @Retry({ limit: 5, delay: 50 })
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API()
    @UseResponseConverter(tagged('child'))
    @Retry({ limit: 2 })
    class Child extends Base {}

    const { api, metas } = clientOf(Child)

    await expect(api.a()).resolves.toEqual({ tag: 'child', body: { id: '0' } })
    expect(metas[0].retry?.limit).toBe(2)
    expect(metas[0].retry?.delay).toBe(500)
  })

  it("applies a base class's @FormURLEncoded() to a subclass's form operation", async () => {
    @API('/token')
    @FormURLEncoded()
    class Base {}

    class Child extends Base {
      @POST('/')
      @Params([Field('grant_type')])
      token(_grantType: string): Promise<unknown> {
        return noop()
      }
    }

    const { api, sent } = clientOf(Child)
    await api.token('client_credentials')

    expect(sent()?.body).toBe('grant_type=client_credentials')
    expect(sent()?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  // A path placeholder the subclass adds reaches every inherited operation too, and one that cannot fill it is a
  // broken route. The error names the class that declares the operation, which is where the fix goes.
  it('rejects an inherited operation that cannot fill a placeholder of the subclass path, naming Base.member', () => {
    let constructed = 0

    class Base {
      @GET('/users')
      list(): Promise<unknown> {
        return noop()
      }
    }

    @API('/tenants/{tenant}')
    class Child extends Base {
      constructor() {
        super()
        constructed++
      }
    }

    const client = newClient().baseURL('http://example.test').callFactory(new TestCallFactory()).build()

    expect(() => client.create(Child)).toThrow(ErrFetchyInvalidRoute)
    expect(() => client.create(Child)).toThrow('Invalid route configuration for method "Base.list"')
    expect(constructed).toBe(0)
  })

  it('serves the operations of every class in the chain, past an undecorated one', async () => {
    @API('/users')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    class Mid extends Base {}

    class Leaf extends Mid {
      @GET('/b')
      b(): Promise<unknown> {
        return noop()
      }
    }

    const { api, sent } = clientOf(Leaf, 2)

    await api.a()
    expect(sent()?.url).toBe('http://example.test/users/a')

    await api.b()
    expect(sent()?.url).toBe('http://example.test/users/b')
  })

  // A class decorator makes SWC link the subclass's metadata to its parent's, as tsc always does. Read through that
  // link, the parent's operation would be served twice.
  it("serves each operation once when the subclass's metadata links to its parent's", () => {
    @API('/users')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API()
    class Child extends Base {
      @GET('/b')
      b(): Promise<unknown> {
        return noop()
      }
    }

    const { api } = clientOf(Child)

    expect(Object.getOwnPropertySymbols(api)).toHaveLength(2)
  })

  // The merge builds a new configuration for each class it resolves, so a subclass never changes what its parent sends.
  it("keeps the base class's own path for a client of the base built after one of the subclass", async () => {
    @API('/v1')
    class Base {
      @GET('/a')
      a(): Promise<unknown> {
        return noop()
      }
    }

    @API('/v2')
    class Child extends Base {}

    const child = clientOf(Child)
    const base = clientOf(Base)
    await child.api.a()
    await base.api.a()

    expect(child.sent()?.url).toBe('http://example.test/v2/a')
    expect(base.sent()?.url).toBe('http://example.test/v1/a')
  })
})
