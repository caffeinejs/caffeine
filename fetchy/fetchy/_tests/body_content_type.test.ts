import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { ContentType } from '../decorators/content_type.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Header } from '../decorators/params/header.js'
import { Path } from '../decorators/path.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { POST } from '../decorators/verbs.js'
import { MediaTypes } from '../media_types.js'
import { noop } from '../noop.js'
import type { FetchyRequest } from '../request.js'
import {
  FormRequestBodyConverter,
  RawRequestBodyConverter,
  type RequestBodyConverter,
} from '../request_body_converter.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

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

@API()
@Path('/users')
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

function build(callFactory: TestCallFactory): any {
  return newClient().baseURL('http://example.test').callFactory(callFactory).build().create(BodyAPI)
}

async function contentTypeOf(call: (api: any) => Promise<unknown>): Promise<string | null> {
  const callFactory = new TestCallFactory()
  const api = build(callFactory)
  callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

  await call(api)

  return callFactory.calls[0].lastRequest?.headers.get('content-type') ?? null
}

describe('the content-type of a converted body', () => {
  it('labels a JSON-stringified body application/json', async () => {
    expect(await contentTypeOf(api => api.create({ name: 'Ada' }))).toBe(MediaTypes.JSON)
  })

  // A string may be anything, a Blob carries its own type, and `fetch` labels a URLSearchParams itself.
  // Claiming JSON for any of them would be a lie the server acts on.
  it('leaves a value the converter passes through untouched unlabelled', async () => {
    expect(await contentTypeOf(api => api.create('already encoded'))).toBe('text/plain;charset=UTF-8')
    expect(await contentTypeOf(api => api.create(new URLSearchParams({ a: '1' })))).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    )
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
@API()
@Path('/token')
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
    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(FieldDeclaredAPI)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

    await call(api)

    return callFactory.calls[0].lastRequest!
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

@API()
@Path('/token')
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

@API()
@Path('/token')
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
    const callFactory = new TestCallFactory()
    const api = newClient().baseURL('http://example.test').callFactory(callFactory).build().create(TargetAPI)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

    await call(api)

    return callFactory.calls[0].lastRequest!
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
})
