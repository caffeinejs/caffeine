import { describe, expect, it } from 'vitest'

import { Accept } from '../decorators/accept.js'
import { ContentType } from '../decorators/content_type.js'
import { FormUrlEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { GET, POST } from '../decorators/verbs.js'
import { allMethodMeta, readClassMeta } from '../metadata.js'
import { noop } from '../noop.js'

function metadataOf(ctor: Function): DecoratorMetadataObject {
  return (ctor as unknown as { [Symbol.metadata]: DecoratorMetadataObject })[Symbol.metadata]
}

describe('header/form decorators', () => {
  it('@HeaderMap/@ContentType/@Accept at class level write into ClassMeta', () => {
    @HeaderMap({ 'x-api-key': 'secret' })
    @ContentType('application/json')
    @Accept('application/json')
    class Api {
      @GET('/x')
      get(): Promise<unknown> {
        return noop()
      }
    }

    const meta = readClassMeta(metadataOf(Api))

    expect(meta?.headers.get('x-api-key')).toBe('secret')
    expect(meta?.headers.get('content-type')).toBe('application/json')
    expect(meta?.headers.get('accept')).toBe('application/json')
  })

  it('@HeaderMap/@ContentType/@Accept at method level write into that method\'s MethodMeta only', () => {
    class Api {
      @GET('/x')
      @HeaderMap({ 'x-trace': '1' })
      @ContentType('text/plain')
      one(): Promise<unknown> {
        return noop()
      }

      @GET('/y')
      two(): Promise<unknown> {
        return noop()
      }
    }

    const methods = allMethodMeta(metadataOf(Api))

    expect(methods.get('one')?.headers.get('x-trace')).toBe('1')
    expect(methods.get('one')?.headers.get('content-type')).toBe('text/plain')
    expect(methods.get('two')?.headers.has('x-trace')).toBe(false)
  })

  it('@FormUrlEncoded sets formUrlEncoded/requestType and the content-type header at method level', () => {
    class Api {
      @POST('/form')
      @FormUrlEncoded()
      submit(): Promise<unknown> {
        return noop()
      }
    }

    const method = allMethodMeta(metadataOf(Api)).get('submit')

    expect(method?.formUrlEncoded).toBe(true)
    expect(method?.requestType).toBe('form')
    expect(method?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  it('@FormUrlEncoded at class level sets requestType without the per-method flag', () => {
    @FormUrlEncoded()
    class Api {
      @POST('/form')
      submit(): Promise<unknown> {
        return noop()
      }
    }

    const meta = readClassMeta(metadataOf(Api))

    expect(meta?.requestType).toBe('form')
    expect(meta?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })
})
