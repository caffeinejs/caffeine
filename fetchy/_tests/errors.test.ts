import { describe, expect, it } from 'vitest'

import {
  ErrFetchyClientNotBuilt,
  ErrFetchyEmptyClient,
  ErrFetchyHttp,
  ErrFetchyInvalidDecoratorTarget,
  ErrFetchyInvalidRoute,
  ErrFetchyNoParameterHandler,
  ErrFetchyNoResponseConverter,
} from '../errors.js'

describe('errors', () => {
  it.each([
    ['ErrFetchyInvalidDecoratorTarget', () => new ErrFetchyInvalidDecoratorTarget('Path', 'a class'), 'ERR_FETCHY_INVALID_DECORATOR_TARGET'],
    ['ErrFetchyInvalidRoute', () => new ErrFetchyInvalidRoute('getUser', 'missing HTTP method'), 'ERR_FETCHY_INVALID_ROUTE'],
    ['ErrFetchyEmptyClient', () => new ErrFetchyEmptyClient('UsersApi'), 'ERR_FETCHY_EMPTY_CLIENT'],
    ['ErrFetchyNoParameterHandler', () => new ErrFetchyNoParameterHandler('model', 'getUser', 0), 'ERR_FETCHY_NO_PARAMETER_HANDLER'],
    ['ErrFetchyNoResponseConverter', () => new ErrFetchyNoResponseConverter('xml', 'getUser'), 'ERR_FETCHY_NO_RESPONSE_CONVERTER'],
    ['ErrFetchyClientNotBuilt', () => new ErrFetchyClientNotBuilt('getUser'), 'ERR_FETCHY_CLIENT_NOT_BUILT'],
  ] as const)('%s has name and code aligned', (name, factory, code) => {
    const error = factory()

    expect(error.name).toBe(name)
    expect(error.code).toBe(code)
    expect(error).toBeInstanceOf(Error)
  })

  it('ErrFetchyHttp carries request/response details', () => {
    const request = new Request('http://x.test/users/1', { method: 'GET' })
    const response = new Response(null, { status: 404, statusText: 'Not Found' })

    const error = new ErrFetchyHttp(request, response, { message: 'not found' })

    expect(error.name).toBe('ErrFetchyHttp')
    expect(error.code).toBe('ERR_FETCHY_HTTP')
    expect(error.status).toBe(404)
    expect(error.statusText).toBe('Not Found')
    expect(error.body).toEqual({ message: 'not found' })
    expect(error.request).toBe(request)
    expect(error.toJSON()).toMatchObject({ code: 'ERR_FETCHY_HTTP', status: 404 })
  })
})
