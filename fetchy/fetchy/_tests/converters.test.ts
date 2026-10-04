import { describe, expect, it } from 'vitest'

import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { Path } from '../decorators/path.js'
import { RawResponse } from '../decorators/raw_response.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { UseResponseHandler } from '../decorators/response_handler.js'
import { GET, HEAD, POST } from '../decorators/verbs.js'
import { ErrFetchyHTTP, ErrFetchyInvalidFormBody } from '../errors.js'
import { noop } from '../noop.js'
import { FormRequestBodyConverter, RawRequestBodyConverter } from '../request_body_converter.js'
import { JSONResponseConverter, TextResponseConverter } from '../response_converter.js'
import { NoopResponseHandler } from '../response_handler.js'
import { fakeJSONResponse, TestCallFactory } from './test_call_factory.js'

@API()
@Path('/users')
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

@API()
@Path('/users')
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

function buildClient(TargetAPI: new () => object, callFactory: TestCallFactory): any {
  const client = newClient().baseURL('http://example.test').callFactory(callFactory).build()
  return client.create(TargetAPI)
}

describe('converters', () => {
  it('FormRequestBodyConverter form-encodes a @Body() value via @UseRequestBodyConverter', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, { id: '1' }))

    await api.createFormUser({ name: 'Ada' })

    expect(callFactory.calls[0].lastRequest?.body).toBe(new URLSearchParams({ name: 'Ada' }).toString())
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

  // A HEAD response never has a body. Before an empty body read as `undefined`, every @HEAD operation rejected with a
  // SyntaxError after a successful response.
  it('resolves a HEAD operation with undefined instead of failing on the missing body', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(new Response(null, { status: 200 }))

    await expect(api.hasUser('1')).resolves.toBeUndefined()
  })

  // A 201 with no content means the resource exists. Rejecting it invites the caller to retry and create it twice.
  it('resolves an empty 2xx body with undefined', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(new Response('', { status: 201 }))

    await expect(api.createUser({ name: 'Ada' })).resolves.toBeUndefined()
  })

  // Only an empty body is special. A body that is not JSON still fails loudly.
  it('still rejects a body that is not JSON', async () => {
    await expect(JSONResponseConverter.convert(new Response('{', { status: 200 }))).rejects.toBeInstanceOf(SyntaxError)
  })

  it('TextResponseConverter returns the body as plain text via @UseResponseConverter', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(new Response('hello world', { status: 200 }))

    const result = await api.getUserText('1')

    expect(result).toBe('hello world')
  })

  it('TextResponseConverter returns an empty string for a 204 response', async () => {
    const result = await TextResponseConverter.convert(new Response(null, { status: 204 }))

    expect(result).toBe('')
  })

  it('@RawResponse() returns the raw Response and does not throw on a non-ok status', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(404, { message: 'not found' }, 'Not Found'))

    const response = await api.getUserRaw('404')

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(404)
  })

  it('@UseResponseHandler(NoopResponseHandler) does not throw, but the converter still runs', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { message: 'boom' }))

    const result = await api.getUserNoopHandler('1')

    expect(result).toEqual({ message: 'boom' })
  })

  it('a non-ok response still throws ErrFetchyHTTP without @UseResponseHandler', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(500, { message: 'boom' }))

    await expect(api.getUserText('1')).rejects.toBeInstanceOf(ErrFetchyHTTP)
  })

  it('inherits a class-level @UseRequestBodyConverter() default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ClassDefaultConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

    await api.createUser({ name: 'Ada' })

    expect(callFactory.calls[0].lastRequest?.body).toBe(new URLSearchParams({ name: 'Ada' }).toString())
  })

  it('a method-level @UseRequestBodyConverter() overrides the class-level default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ClassDefaultConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

    await api.createUserOverride('raw-body')

    expect(callFactory.calls[0].lastRequest?.body).toBe('raw-body')
  })
})
