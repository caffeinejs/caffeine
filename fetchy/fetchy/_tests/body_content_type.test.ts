import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { ContentType } from '../decorators/content_type.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Header } from '../decorators/params/header.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { POST } from '../decorators/verbs.js'
import { ErrFetchyInvalidFormBody } from '../errors.js'
import { MediaTypes } from '../media_types.js'
import { noop } from '../noop.js'
import type { FetchyRequest } from '../request.js'
import {
  FormRequestBodyConverter,
  RawRequestBodyConverter,
  type RequestBodyConverter,
} from '../request_body_converter.js'
import { OtherFormData } from './other_form_data.js'
import { fakeJSONResponse, TestTransportFactory } from './test_transport_factory.js'

/**
 * A body that was JSON-stringified has to say so. Without a `content-type`, `fetch` labels a string body
 * `text/plain;charset=UTF-8`, and a strict server — Keycloak's Admin API, for one — answers 415 to every
 * request. The converter is asked per value, because it passes some values through untouched and those are
 * not JSON.
 */

/** A converter written before `contentType` existed: it must still work, and must set no header. */
const LegacyConverter: RequestBodyConverter = {
  convert(value: unknown) {
    return String(value)
  },
}

@API('/users')
class BodyAPI {
  @POST('/')
  @Params([Body()])
  create(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/declared')
  @ContentType('application/vnd.acme+json')
  @Params([Body()])
  createDeclared(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/form')
  @UseRequestBodyConverter(FormRequestBodyConverter)
  @Params([Body()])
  createForm(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/raw')
  @UseRequestBodyConverter(RawRequestBodyConverter)
  @Params([Body()])
  createRaw(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/legacy')
  @UseRequestBodyConverter(LegacyConverter)
  @Params([Body()])
  createLegacy(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/typed-after')
  @Params([Body(), Header('content-type')])
  createTypedAfter(_body: unknown, _contentType: string): Promise<unknown> {
    return noop()
  }

  @POST('/typed-before')
  @Params([Header('content-type'), Body()])
  createTypedBefore(_contentType: string, _body: unknown): Promise<unknown> {
    return noop()
  }
}

function build(transportFactory: TestTransportFactory): any {
  return newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(BodyAPI)
}

async function contentTypeOf(call: (api: any) => Promise<unknown>): Promise<string | null> {
  const transportFactory = new TestTransportFactory()
  const api = build(transportFactory)
  transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

  await call(api)

  return transportFactory.transports[0].lastRequest?.headers.get('content-type') ?? null
}

describe('the content-type of a converted body', () => {
  it('labels a JSON-stringified body application/json', async () => {
    expect(await contentTypeOf(api => api.create({ name: 'Ada' }))).toBe(MediaTypes.JSON)
  })

  // A string may be anything, a Blob carries its own type, `fetch` labels a URLSearchParams itself, and the transport
  // labels a FormData with the boundary it generates. Claiming JSON for any of them would be a lie the server acts on.
  it('leaves a value the converter passes through untouched unlabelled', async () => {
    expect(await contentTypeOf(api => api.create('already encoded'))).toBe('text/plain;charset=UTF-8')
    expect(await contentTypeOf(api => api.create(new URLSearchParams({ a: '1' })))).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    )
    expect(await contentTypeOf(api => api.create(new FormData()))).toBeNull()
  })

  // `JSON.stringify` reads an ArrayBuffer and a stream as empty objects, so both went out as `{}` labelled JSON and
  // their bytes never left. Like a typed array or a Blob, each is a body fetch sends as it is.
  it.each([
    ['an ArrayBuffer', (): unknown => new TextEncoder().encode('%PDF-1.7').buffer],
    ['a ReadableStream', (): unknown => new ReadableStream()],
  ])('hands %s to the transport as it is, unlabelled', async (_kind, make) => {
    const body = make()
    const transportFactory = new TestTransportFactory()
    const api = build(transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.create(body)

    const request = transportFactory.transports[0].lastRequest!
    expect(request.body).toBe(body)
    expect(request.headers.get('content-type')).toBeNull()
  })

  // undici's FormData, or one built before `undici.install()` replaced the global, is no instance of the global class,
  // and `JSON.stringify` reads it as `{}`: that text went out labelled JSON, and the parts never left. Handed on as a
  // FormData is, the transport encodes it under the boundary it generates.
  it('hands a FormData of another implementation to the transport as it is, unlabelled', async () => {
    const form = new OtherFormData()
    form.append('title', 'Q3 report')
    const transportFactory = new TestTransportFactory()
    const api = build(transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.create(form)

    const request = transportFactory.transports[0].lastRequest!
    expect(request.body).toBe(form)
    expect(request.headers.get('content-type')).toBeNull()
  })

  it('does not overwrite a content-type the declaration already set', async () => {
    expect(await contentTypeOf(api => api.createDeclared({ name: 'Ada' }))).toBe('application/vnd.acme+json')
  })

  // The converter's label only fills a gap, so a content-type argument wins wherever it sits. Labelling as the body
  // was applied used to send `application/json, application/vnd.acme+json` when the header argument came second.
  it('does not overwrite a content-type argument, before or after the body', async () => {
    const contentType = 'application/vnd.acme+json'

    expect(await contentTypeOf(api => api.createTypedAfter({ name: 'Ada' }, contentType))).toBe(contentType)
    expect(await contentTypeOf(api => api.createTypedBefore(contentType, { name: 'Ada' }))).toBe(contentType)
  })

  it('labels a form-encoded body from the form converter', async () => {
    expect(await contentTypeOf(api => api.createForm({ name: 'Ada' }))).toBe(MediaTypes.FORM_URL_ENCODED)
  })

  // `contentType` is optional, so a converter that predates it keeps working and simply sets no header.
  it('sets no header for a converter that does not name a media type', async () => {
    expect(await contentTypeOf(api => api.createRaw('raw'))).toBe('text/plain;charset=UTF-8')
    expect(await contentTypeOf(api => api.createLegacy({ name: 'Ada' }))).toBe('text/plain;charset=UTF-8')
  })
})

/**
 * An operation may be declared as a field rather than a method. A field decorator is handed `undefined` where
 * a method decorator is handed the function, so `@ContentType` and `@FormURLEncoded` used to be rejected here
 * with `TS1240` — a compile-time failure, which is why `decorators.test-d.ts` is what pins the types. This
 * pins the behaviour they unlock: the decorators have to do their work in this position too.
 */
@API('/token')
class FieldDeclaredAPI {
  @POST('/form')
  @FormURLEncoded()
  @Params([Field('grant_type')])
  token!: (grantType: string) => Promise<unknown>

  @POST('/json')
  @ContentType('application/vnd.acme+json')
  @Params([Body()])
  create!: (body: unknown) => Promise<unknown>
}

describe('an operation declared as a field', () => {
  async function callField(call: (api: any) => Promise<unknown>): Promise<FetchyRequest> {
    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test')
      .transportFactory(transportFactory)
      .build()
      .create(FieldDeclaredAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await call(api)

    return transportFactory.transports[0].lastRequest!
  }

  it('applies @FormURLEncoded() in the field position', async () => {
    const request = await callField(api => api.token('client_credentials'))

    expect(request.headers.get('content-type')).toBe(MediaTypes.FORM_URL_ENCODED)
    expect(request.body).toBe(new URLSearchParams({ grant_type: 'client_credentials' }).toString())
  })

  it('applies @ContentType() in the field position', async () => {
    const request = await callField(api => api.create({ name: 'Ada' }))

    expect(request.headers.get('content-type')).toBe('application/vnd.acme+json')
  })
})

/**
 * `@FormURLEncoded()` labels the body `application/x-www-form-urlencoded`, so a `@Body()` value has to be form-encoded
 * too. An object used to go out as JSON under the form label, which the server then reads as one garbled field.
 */
const MarkedConverter: RequestBodyConverter = {
  convert() {
    return 'marked'
  },
}

@API('/token')
class FormBodyAPI {
  @POST('/')
  @FormURLEncoded()
  @Params([Body()])
  token(_body: unknown): Promise<unknown> {
    return noop()
  }

  // Listed above @FormURLEncoded(), the explicit converter is applied last and wins, as a second header would.
  @POST('/marked')
  @UseRequestBodyConverter(MarkedConverter)
  @FormURLEncoded()
  @Params([Body()])
  tokenMarked(_body: unknown): Promise<unknown> {
    return noop()
  }
}

@API('/token')
@FormURLEncoded()
class ClassFormBodyAPI {
  @POST('/')
  @Params([Body()])
  token(_body: unknown): Promise<unknown> {
    return noop()
  }
}

describe('a @Body() under @FormURLEncoded()', () => {
  async function send(TargetAPI: new () => object, call: (api: any) => Promise<unknown>): Promise<FetchyRequest> {
    const transportFactory = new TestTransportFactory()
    const api = newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(TargetAPI)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await call(api)

    return transportFactory.transports[0].lastRequest!
  }

  // An OAuth token request is the common case, and an unset optional `scope` must not reach the server as text.
  it('is form-encoded under the form label at method level', async () => {
    const request = await send(FormBodyAPI, api => api.token({ grant_type: 'client_credentials', scope: undefined }))

    expect(request.headers.get('content-type')).toBe(MediaTypes.FORM_URL_ENCODED)
    expect(request.body).toBe('grant_type=client_credentials')
  })

  it('is form-encoded under the form label at class level', async () => {
    const request = await send(ClassFormBodyAPI, api => api.token({ grant_type: 'client_credentials' }))

    expect(request.headers.get('content-type')).toBe(MediaTypes.FORM_URL_ENCODED)
    expect(request.body).toBe('grant_type=client_credentials')
  })

  it('leaves an explicit converter in charge when it is listed above', async () => {
    const request = await send(FormBodyAPI, api => api.tokenMarked({ grant_type: 'client_credentials' }))

    expect(request.body).toBe('marked')
  })

  // Bytes are a form already encoded, as a typed array's are. Read as an object, an ArrayBuffer went out as an empty form.
  it('hands an ArrayBuffer on as the encoded form it already is', async () => {
    const bytes = new TextEncoder().encode('grant_type=client_credentials').buffer
    const request = await send(FormBodyAPI, api => api.token(bytes))

    expect(request.headers.get('content-type')).toBe(MediaTypes.FORM_URL_ENCODED)
    expect(request.body).toBe(bytes)
  })

  // A string is the form already encoded, as a caller who built it by hand sends it.
  it('sends a string as the encoded form it already is', async () => {
    const request = await send(FormBodyAPI, api => api.token('grant_type=client_credentials&scope=read'))

    expect(request.headers.get('content-type')).toBe(MediaTypes.FORM_URL_ENCODED)
    expect(request.body).toBe('grant_type=client_credentials&scope=read')
  })

  // A FormData is multipart material, of any implementation. Read field by field, undici's gave nothing, and an empty
  // form went out in its place.
  it('rejects a FormData of another implementation and sends nothing', async () => {
    const form = new OtherFormData()
    form.append('grant_type', 'client_credentials')
    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test')
      .transportFactory(transportFactory)
      .build()
      .create(FormBodyAPI)

    const error = await api.token(form).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ErrFetchyInvalidFormBody)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot convert a FormData to application/x-www-form-urlencoded: FormData is sent as multipart/form-data',
    )
    expect(transportFactory.transports[0].sendCount).toBe(0)
  })

  // A form is name and value pairs, and a lone value is neither. fetch sent a number as the text `42` under the form
  // label, and undici refused it with an error that named no fetchy API. Refused before anything is sent, the error
  // names the value's type and the fix.
  it.each([
    ['a number', 42, 'number'],
    ['a boolean', true, 'boolean'],
    ['a bigint', 42n, 'bigint'],
    ['a symbol', Symbol('q'), 'symbol'],
    ['a function', () => 'q', 'function'],
  ])('rejects %s and sends nothing', async (_kind, value, type) => {
    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test')
      .transportFactory(transportFactory)
      .build()
      .create(FormBodyAPI)

    const error = await api.token(value).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ErrFetchyInvalidFormBody)
    expect((error as Error).message.split('\n')[0]).toBe(
      `Cannot convert the @Body() value to application/x-www-form-urlencoded: expected an object, an array of [key, value] pairs or an encoded string, got ${type}`,
    )
    expect(transportFactory.transports[0].sendCount).toBe(0)
  })
})
