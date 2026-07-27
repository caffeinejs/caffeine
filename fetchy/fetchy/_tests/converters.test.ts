import { describe, expect, it } from 'vitest'

import { API } from '../decorators/api.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { Params } from '../decorators/params.js'
import { Path } from '../decorators/path.js'
import { RawResponse } from '../decorators/raw_response.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { UseResponseConverter } from '../decorators/response_converter.js'
import { UseResponseHandler } from '../decorators/response_handler.js'
import { GET, POST } from '../decorators/verbs.js'
import { newClient } from '../client_builder.js'
import { ErrFetchyHTTP, ErrFetchyInvalidFormBody } from '../errors.js'
import { noop } from '../noop.js'
import { FormRequestBodyConverter, RawRequestBodyConverter } from '../request_body_converter.js'
import { TextResponseConverter } from '../response_converter.js'
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

    expect(await callFactory.calls[0].lastRequest?.clone().text()).toBe(
      new URLSearchParams({ name: 'Ada' }).toString(),
    )
  })

  it('FormRequestBodyConverter throws ErrFetchyInvalidFormBody for a flat array', () => {
    expect(() => FormRequestBodyConverter.convert(['a', 'b'])).toThrow(ErrFetchyInvalidFormBody)
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

    expect(await callFactory.calls[0].lastRequest?.clone().text()).toBe(
      new URLSearchParams({ name: 'Ada' }).toString(),
    )
  })

  it('a method-level @UseRequestBodyConverter() overrides the class-level default', async () => {
    const callFactory = new TestCallFactory()
    const api = buildClient(ClassDefaultConverterAPI, callFactory)
    callFactory.calls[0].willRespond(fakeJSONResponse(200, {}))

    await api.createUserOverride('raw-body')

    expect(await callFactory.calls[0].lastRequest?.clone().text()).toBe('raw-body')
  })
})
