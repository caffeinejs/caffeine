import { describe, expect, it } from 'vitest'

import { Accept } from '../decorators/accept.js'
import { ContentType } from '../decorators/content_type.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { getClassBuilder, getMethodBuilders } from '../decorators/registrar/registrar.js'
import { GET, POST } from '../decorators/verbs.js'
import { noop } from '../noop.js'
import { captureMetadata } from './capture_metadata.js'

describe('header/form decorators', () => {
  it('@HeaderMap/@ContentType/@Accept at class level write into the class registrar entry', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    @HeaderMap({ 'x-api-key': 'secret' })
    @ContentType('application/json')
    @Accept('application/json')
    class API {
      @GET('/x')
      get(): Promise<unknown> {
        return noop()
      }
    }

    const spec = getClassBuilder(metadata())?.toClassSpec()

    expect(spec?.headers.get('x-api-key')).toBe('secret')
    expect(spec?.headers.get('content-type')).toBe('application/json')
    expect(spec?.headers.get('accept')).toBe('application/json')
  })

  it('@HeaderMap/@ContentType/@Accept at method level write into that method\'s registrar entry only', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
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

    const methods = getMethodBuilders(metadata())

    expect(methods.get('one')?.toMethodSpec().headers.get('x-trace')).toBe('1')
    expect(methods.get('one')?.toMethodSpec().headers.get('content-type')).toBe('text/plain')
    expect(methods.get('two')?.toMethodSpec().headers.has('x-trace')).toBe(false)
  })

  it('@FormURLEncoded sets formURLEncoded/requestType and the content-type header at method level', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
      @POST('/form')
      @FormURLEncoded()
      submit(): Promise<unknown> {
        return noop()
      }
    }

    const spec = getMethodBuilders(metadata()).get('submit')?.toMethodSpec()

    expect(spec?.formURLEncoded).toBe(true)
    expect(spec?.requestType).toBe('form')
    expect(spec?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  it('@FormURLEncoded at class level sets requestType without the per-method flag', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    @FormURLEncoded()
    class API {
      @POST('/form')
      submit(): Promise<unknown> {
        return noop()
      }
    }

    const spec = getClassBuilder(metadata())?.toClassSpec()

    expect(spec?.requestType).toBe('form')
    expect(spec?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  it('two same-level decorators setting the same header override rather than concatenate', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
      @POST('/form')
      @ContentType('application/json')
      @FormURLEncoded()
      submit(): Promise<unknown> {
        return noop()
      }
    }

    const headers = getMethodBuilders(metadata()).get('submit')?.toMethodSpec().headers

    // Applied bottom-up: @FormURLEncoded sets content-type first, @ContentType overrides it second.
    expect(headers?.get('content-type')).toBe('application/json')
  })
})
