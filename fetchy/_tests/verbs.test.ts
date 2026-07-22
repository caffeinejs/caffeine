import { describe, expect, it } from 'vitest'

import { DELETE, GET, HEAD, HTTP, OPTIONS, PATCH, POST, PUT } from '../decorators/verbs.js'
import { Path } from '../decorators/path.js'
import { allMethodMeta, readClassMeta } from '../metadata.js'
import { noop } from '../noop.js'

describe('verb decorators', () => {
  it('writes httpMethod and path directly onto the class metadata, with no owner resolution', () => {
    class UsersApi {
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

    const methods = allMethodMeta((UsersApi as unknown as { [Symbol.metadata]: DecoratorMetadataObject })[
      Symbol.metadata
    ])

    expect(methods.get('list')?.httpMethod).toBe('GET')
    expect(methods.get('list')?.path).toBe('/users')
    expect(methods.get('create')?.httpMethod).toBe('POST')
    expect(methods.get('update')?.httpMethod).toBe('PUT')
    expect(methods.get('update')?.path).toBe('/users/{id}')
    expect(methods.get('remove')?.httpMethod).toBe('DELETE')
    expect(methods.get('patch')?.httpMethod).toBe('PATCH')
    expect(methods.get('head')?.httpMethod).toBe('HEAD')
    expect(methods.get('options')?.httpMethod).toBe('OPTIONS')
    expect(methods.get('custom')?.httpMethod).toBe('GET')
    expect(methods.get('custom')?.path).toBe('/users/custom')
  })

  it('throws ErrFetchyClientNotBuilt when a decorated method is called without create()', () => {
    class UsersApi {
      @GET('/users')
      list(): Promise<unknown> {
        return noop()
      }
    }

    expect(() => new UsersApi().list()).toThrow(/never passed to FetchyClient.create/)
  })

  it('@Path sets the class-level base path', () => {
    @Path('/api/users')
    class UsersApi {
      @GET('/{id}')
      get(): Promise<unknown> {
        return noop()
      }
    }

    const metadata = (UsersApi as unknown as { [Symbol.metadata]: DecoratorMetadataObject })[Symbol.metadata]

    expect(readClassMeta(metadata)?.path).toBe('/api/users')
  })
})
