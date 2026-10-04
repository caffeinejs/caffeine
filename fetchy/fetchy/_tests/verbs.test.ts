import { describe, expect, it } from 'vitest'

import { HeaderMap } from '../decorators/header_map.js'
import { Params } from '../decorators/params.js'
import { Param } from '../decorators/params/param.js'
import { Path } from '../decorators/path.js'
import { getClassBuilder, getMethodBuilders } from '../decorators/registrar/registrar.js'
import { DELETE, GET, HEAD, HTTP, OPTIONS, PATCH, POST, PUT } from '../decorators/verbs.js'
import { ErrFetchyInvalidDecoratorTarget, ErrFetchyInvalidRoute } from '../errors.js'
import { noop } from '../noop.js'
import { captureMetadata } from './capture_metadata.js'

describe('verb decorators', () => {
  it('writes httpMethod and path into the method registrar entry, with no owner resolution', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class UsersAPI {
      @GET('/users')
      list(): Promise<unknown> {
        return noop()
      }

      @POST('/users')
      create(): Promise<unknown> {
        return noop()
      }

      @PUT('/users/{id}')
      update(): Promise<unknown> {
        return noop()
      }

      @DELETE('/users/{id}')
      remove(): Promise<unknown> {
        return noop()
      }

      @PATCH('/users/{id}')
      patch(): Promise<unknown> {
        return noop()
      }

      @HEAD('/users')
      head(): Promise<unknown> {
        return noop()
      }

      @OPTIONS('/users')
      options(): Promise<unknown> {
        return noop()
      }

      @HTTP('get', '/users/custom')
      custom(): Promise<unknown> {
        return noop()
      }
    }

    const methods = getMethodBuilders(metadata())

    expect(methods.get('list')?.toMethodSpec().httpMethod).toBe('GET')
    expect(methods.get('list')?.toMethodSpec().path).toBe('/users')
    expect(methods.get('create')?.toMethodSpec().httpMethod).toBe('POST')
    expect(methods.get('update')?.toMethodSpec().httpMethod).toBe('PUT')
    expect(methods.get('update')?.toMethodSpec().path).toBe('/users/{id}')
    expect(methods.get('remove')?.toMethodSpec().httpMethod).toBe('DELETE')
    expect(methods.get('patch')?.toMethodSpec().httpMethod).toBe('PATCH')
    expect(methods.get('head')?.toMethodSpec().httpMethod).toBe('HEAD')
    expect(methods.get('options')?.toMethodSpec().httpMethod).toBe('OPTIONS')
    expect(methods.get('custom')?.toMethodSpec().httpMethod).toBe('GET')
    expect(methods.get('custom')?.toMethodSpec().path).toBe('/users/custom')
  })

  it('throws ErrFetchyClientNotBuilt when a decorated method is called without create()', () => {
    class UsersAPI {
      @GET('/users')
      list(): Promise<unknown> {
        return noop()
      }
    }

    expect(() => new UsersAPI().list()).toThrow(/never passed to FetchyClient.create/)
  })

  it('writes httpMethod and path into the method registrar entry when declared as a field', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class UsersAPI {
      @GET('/users')
      list!: () => Promise<unknown>

      @POST('/users')
      create!: () => Promise<unknown>
    }

    const methods = getMethodBuilders(metadata())

    expect(methods.get('list')?.toMethodSpec().httpMethod).toBe('GET')
    expect(methods.get('list')?.toMethodSpec().path).toBe('/users')
    expect(methods.get('create')?.toMethodSpec().httpMethod).toBe('POST')
  })

  it('throws ErrFetchyClientNotBuilt when a field-declared operation is called without create()', () => {
    class UsersAPI {
      @GET('/users')
      list!: () => Promise<unknown>
    }

    expect(() => new UsersAPI().list()).toThrow(/never passed to FetchyClient.create/)
  })

  // Two verbs on one member describe two different requests. The verb applied last used to win in silence, so the
  // other request the author wrote never happened.
  it('rejects a second HTTP verb on the same member when the class is defined', () => {
    expect(
      () =>
        class {
          @GET('/a')
          @POST('/b')
          both(): Promise<unknown> {
            return noop()
          }
        },
    ).toThrow(ErrFetchyInvalidRoute)

    expect(
      () =>
        class {
          @HTTP('GET', '/a')
          @GET('/b')
          twice(): Promise<unknown> {
            return noop()
          }
        },
    ).toThrow('more than one HTTP verb decorator ("GET" and "GET")')
  })

  // Static and instance members share one registry, keyed by name. A static operation was served on the instance by
  // create() and threw on the class, and a static member's configuration leaked into the instance member of the same
  // name.
  it('rejects a static member, for verbs and for every other member decorator', () => {
    expect(
      () =>
        class {
          @GET('/users')
          static list(): Promise<unknown> {
            return noop()
          }
        },
    ).toThrow(ErrFetchyInvalidDecoratorTarget)

    expect(
      () =>
        class {
          @HeaderMap({ 'x-trace': '1' })
          static list(): Promise<unknown> {
            return noop()
          }
        },
    ).toThrow(ErrFetchyInvalidDecoratorTarget)

    expect(
      () =>
        class {
          @Params([Param('id')])
          static list(_id: string): Promise<unknown> {
            return noop()
          }
        },
    ).toThrow(ErrFetchyInvalidDecoratorTarget)
  })

  it('@Path sets the class-level base path', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    @Path('/api/users')
    class UsersAPI {
      @GET('/{id}')
      get(): Promise<unknown> {
        return noop()
      }
    }

    expect(getClassBuilder(metadata())?.toClassSpec().path).toBe('/api/users')
  })
})
