import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { RawResponse } from '../decorators/raw_response.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { UseResponseHandler } from '../decorators/response_handler.js'
import { GET, HEAD, POST } from '../decorators/verbs.js'
import { ErrFetchyHTTP, ErrFetchyInvalidFormBody } from '../errors.js'
import { noop } from '../noop.js'
import {
  FormRequestBodyConverter,
  JSONRequestBodyConverter,
  MultipartRequestBodyConverter,
  RawRequestBodyConverter,
} from '../request_body_converter.js'
import { JSONResponseConverter, TextResponseConverter } from '../response_converter.js'
import { DefaultResponseHandler, NoopResponseHandler } from '../response_handler.js'
import { fakeJSONResponse, TestTransportFactory } from './test_transport_factory.js'

@API('/users')
class ConverterAPI {
  @POST('/')
  @UseRequestBodyConverter(FormRequestBodyConverter)
  @Params([Body()])
  createFormUser(_body: unknown): Promise<unknown> {
    return noop()
  }

  @GET('/{id}')
  @UseResponseConverter(TextResponseConverter)
  @Params([Param('id')])
  getUserText(_id: string): Promise<string> {
    return noop()
  }

  @GET('/{id}')
  @RawResponse()
  @Params([Param('id')])
  getUserRaw(_id: string): Promise<Response> {
    return noop()
  }

  @GET('/{id}')
  @RawResponse()
  @Params([Param('id')])
  getUserRawField!: (id: string) => Promise<Response>

  @GET('/{id}')
  @UseResponseHandler(NoopResponseHandler)
  @Params([Param('id')])
  getUserNoopHandler(_id: string): Promise<unknown> {
    return noop()
  }

  @HEAD('/{id}')
  @Params([Param('id')])
  hasUser(_id: string): Promise<unknown> {
    return noop()
  }

  @POST('/')
  @Params([Body()])
  createUser(_body: unknown): Promise<unknown> {
    return noop()
  }
}

@API('/users')
@UseRequestBodyConverter(FormRequestBodyConverter)
class ClassDefaultConverterAPI {
  @POST('/')
  @Params([Body()])
  createUser(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/')
  @UseRequestBodyConverter(RawRequestBodyConverter)
  @Params([Body()])
  createUserOverride(_body: unknown): Promise<unknown> {
    return noop()
  }
}

function buildClient(TargetAPI: new () => object, transportFactory: TestTransportFactory): any {
  const client = newClient().baseURL('http://example.test').transportFactory(transportFactory).build()
  return client.create(TargetAPI)
}

describe('converters', () => {
  it('FormRequestBodyConverter form-encodes a @Body() value via @UseRequestBodyConverter', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, { id: '1' }))

    await api.createFormUser({ name: 'Ada' })

    expect(transportFactory.transports[0].lastRequest?.body).toBe(new URLSearchParams({ name: 'Ada' }).toString())
  })

  it('FormRequestBodyConverter throws ErrFetchyInvalidFormBody for a flat array', () => {
    expect(() => FormRequestBodyConverter.convert(['a', 'b'])).toThrow(ErrFetchyInvalidFormBody)
  })

  // An optional property left unset is `undefined`. Encoded, it would send `scope=undefined`, which a strict server
  // rejects or, worse, accepts as a value. `@Field()` already leaves such arguments out.
  it('FormRequestBodyConverter leaves out undefined and null values', () => {
    expect(
      FormRequestBodyConverter.convert({ grant_type: 'client_credentials', scope: undefined, audience: null }),
    ).toBe('grant_type=client_credentials')
    expect(
      FormRequestBodyConverter.convert([
        ['grant_type', 'client_credentials'],
        ['scope', undefined],
      ]),
    ).toBe('grant_type=client_credentials')
  })

  // Bytes or a Blob are a body the caller already encoded. They go out as they are, as they do through the JSON
  // converter, rather than being misread as a record or a list of pairs.
  it('FormRequestBodyConverter passes a Blob or typed array through untouched', () => {
    const bytes = new TextEncoder().encode('grant_type=client_credentials')
    const blob = new Blob(['grant_type=client_credentials'])

    expect(FormRequestBodyConverter.convert(bytes)).toBe(bytes)
    expect(FormRequestBodyConverter.convert(blob)).toBe(blob)
  })

  // A FormData is multipart. Sent as it is under the form label, a server would read it as one garbled field.
  it('FormRequestBodyConverter refuses a FormData, which @Multipart() sends', () => {
    expect(() => FormRequestBodyConverter.convert(new FormData())).toThrow(
      'Cannot convert a FormData to application/x-www-form-urlencoded: FormData is sent as multipart/form-data',
    )
  })

  // `JSON.stringify` reads a FormData as an empty object, so it used to go out as `{}` labelled JSON, its parts lost.
  it('JSONRequestBodyConverter passes a FormData through, unlabelled for the transport to label', () => {
    const form = new FormData()

    expect(JSONRequestBodyConverter.convert(form)).toBe(form)
    expect(JSONRequestBodyConverter.contentType?.(form)).toBeUndefined()
  })

  it('MultipartRequestBodyConverter passes a FormData through and turns a plain object into parts', () => {
    const form = new FormData()
    const converted = MultipartRequestBodyConverter.convert({ title: 'Q3 report', tags: ['finance', 'q3'] }) as FormData

    expect(MultipartRequestBodyConverter.convert(form)).toBe(form)
    expect(MultipartRequestBodyConverter.convert(undefined)).toBeNull()
    expect([...converted.entries()]).toEqual([
      ['title', 'Q3 report'],
      ['tags', 'finance'],
      ['tags', 'q3'],
    ])
  })

  // A dictionary built with `Object.create(null)` holds its parts as a plain object does.
  it('MultipartRequestBodyConverter accepts an object with no prototype', () => {
    const parts = Object.assign(Object.create(null) as Record<string, unknown>, { title: 'Q3 report' })

    expect([...(MultipartRequestBodyConverter.convert(parts) as FormData).entries()]).toEqual([['title', 'Q3 report']])
  })

  // undici exports a FormData of its own, which `instanceof FormData` does not recognize. Refused as "not a FormData",
  // it would leave the caller puzzled; it has to be named for what it is.
  it('MultipartRequestBodyConverter names a FormData from another implementation', () => {
    class OtherFormData {
      get [Symbol.toStringTag](): string {
        return 'FormData'
      }
    }

    expect(() => MultipartRequestBodyConverter.convert(new OtherFormData())).toThrow(
      'Cannot convert the @Body() value to multipart/form-data: it is a FormData from another implementation, such as the one undici exports',
    )
  })

  // undici's `install()` replaces the global FormData with its own class, unrelated to the first. A body built from the
  // global in place when the call is made is a FormData to fetchy, whichever class that is.
  it('recognizes a FormData of the global that replaced the first one', () => {
    const original = globalThis.FormData

    class InstalledFormData {
      get [Symbol.toStringTag](): string {
        return 'FormData'
      }
    }

    try {
      expect(MultipartRequestBodyConverter.convert(new original())).toBeInstanceOf(original)

      globalThis.FormData = InstalledFormData as unknown as typeof FormData
      const form = new InstalledFormData()

      expect(MultipartRequestBodyConverter.convert(form)).toBe(form)
      expect(JSONRequestBodyConverter.convert(form)).toBe(form)
    } finally {
      globalThis.FormData = original
    }
  })

  // A HEAD response never has a body. Before an empty body read as `undefined`, every @HEAD operation rejected with a
  // SyntaxError after a successful response.
  it('resolves a HEAD operation with undefined instead of failing on the missing body', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(new Response(null, { status: 200 }))

    await expect(api.hasUser('1')).resolves.toBeUndefined()
  })

  // A 201 with no content means the resource exists. Rejecting it invites the caller to retry and create it twice.
  it('resolves an empty 2xx body with undefined', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(new Response('', { status: 201 }))

    await expect(api.createUser({ name: 'Ada' })).resolves.toBeUndefined()
  })

  // Only an empty body is special. A body that is not JSON still fails loudly.
  it('still rejects a body that is not JSON', async () => {
    await expect(JSONResponseConverter.convert(new Response('{', { status: 200 }))).rejects.toBeInstanceOf(SyntaxError)
  })

  it('TextResponseConverter returns the body as plain text via @UseResponseConverter', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(new Response('hello world', { status: 200 }))

    const result = await api.getUserText('1')

    expect(result).toBe('hello world')
  })

  it('TextResponseConverter returns an empty string for a 204 response', async () => {
    const result = await TextResponseConverter.convert(new Response(null, { status: 204 }))

    expect(result).toBe('')
  })

  it('@RawResponse() returns the raw Response and does not throw on a non-ok status', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const response = await api.getUserRaw('404')

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(404)
  })

  it('@RawResponse() returns the raw Response of a field-declared operation too', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const response = await api.getUserRawField('404')

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(404)
  })

  it('@UseResponseHandler(NoopResponseHandler) does not throw, but the converter still runs', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(500, { message: 'boom' }))

    const result = await api.getUserNoopHandler('1')

    expect(result).toEqual({ message: 'boom' })
  })

  it('a non-ok response still throws ErrFetchyHTTP without @UseResponseHandler', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(500, { message: 'boom' }))

    await expect(api.getUserText('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('inherits a class-level @UseRequestBodyConverter() default', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ClassDefaultConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.createUser({ name: 'Ada' })

    expect(transportFactory.transports[0].lastRequest?.body).toBe(new URLSearchParams({ name: 'Ada' }).toString())
  })

  it('a method-level @UseRequestBodyConverter() overrides the class-level default', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ClassDefaultConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.createUserOverride('raw-body')

    expect(transportFactory.transports[0].lastRequest?.body).toBe('raw-body')
  })

  it('FormRequestBodyConverter sends a URLSearchParams as its form string', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api.createFormUser(new URLSearchParams({ name: 'Ada Lovelace' }))

    expect(transportFactory.transports[0].lastRequest?.body).toBe('name=Ada+Lovelace')
  })
})

// An optional body left out must reach the server as no body at all, not as the text "undefined" or an empty form.
describe('an absent @Body()', () => {
  it.each([
    ['the JSON converter', 'createUser', undefined],
    ['the form converter', 'createFormUser', null],
  ])('sends no body and no content-type under %s', async (_converter, operation, value) => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(200, {}))

    await api[operation](value)

    const request = transportFactory.transports[0].lastRequest!

    expect(request.body).toBeNull()
    expect(request.headers.has('content-type')).toBe(false)
  })

  // A converter that delegates to this one asks it for a label with whatever value it holds.
  it('gets no label from FormRequestBodyConverter', () => {
    expect(FormRequestBodyConverter.contentType?.(undefined)).toBeUndefined()
  })
})

describe('response handling', () => {
  // A gateway answers an outage with an HTML page: the caller still gets the status to act on, not a SyntaxError.
  it('throws ErrFetchyHTTP with no body for an error response that is not JSON', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(
      new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    )

    const error = await api.createUser({ name: 'Ada' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ErrFetchyHTTP)
    expect((error as ErrFetchyHTTP).status).toBe(502)
    expect((error as ErrFetchyHTTP).body).toBeUndefined()
  })

  it('resolves a 204 with undefined', async () => {
    const transportFactory = new TestTransportFactory()
    const api = buildClient(ConverterAPI, transportFactory)
    transportFactory.transports[0].willRespond(new Response(null, { status: 204 }))

    await expect(api.createUser({ name: 'Ada' })).resolves.toBeUndefined()
  })

  it('applies a class-level @UseResponseHandler() to every operation', async () => {
    @API('/users')
    @UseResponseHandler(NoopResponseHandler)
    class LenientAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = buildClient(LenientAPI, transportFactory)
    transportFactory.transports[0].willRespond(fakeJSONResponse(404, { message: 'not found' }))

    await expect(api.getUser('1')).resolves.toEqual({ message: 'not found' })
  })

  // Installed by name, the default handler reads error bodies with the converter it is given, and still passes a
  // success through untouched.
  it('passes a success through an explicit DefaultResponseHandler, which reads error bodies its own way', async () => {
    @API('/users')
    @UseResponseHandler(new DefaultResponseHandler(TextResponseConverter))
    class TextErrorsAPI {
      @GET('/{id}')
      @Params([Param('id')])
      getUser(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const transportFactory = new TestTransportFactory()
    const api = buildClient(TextErrorsAPI, transportFactory)
    transportFactory.transports[0]
      .willRespond(fakeJSONResponse(200, { id: '1' }))
      .willRespond(new Response('quota exceeded', { status: 429 }))

    await expect(api.getUser('1')).resolves.toEqual({ id: '1' })

    const error = await api.getUser('2').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ErrFetchyHTTP)
    expect((error as ErrFetchyHTTP).body).toBe('quota exceeded')
  })
})
