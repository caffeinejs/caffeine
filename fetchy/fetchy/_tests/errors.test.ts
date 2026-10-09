import { describe, expect, it } from 'vitest'

import {
  ErrFetchy,
  ErrFetchyClientNotBuilt,
  ErrFetchyEmptyClient,
  ErrFetchyFollowUpNotSent,
  ErrFetchyHTTP,
  ErrFetchyInvalidDecoratorTarget,
  ErrFetchyInvalidRoute,
  ErrFetchyMissingPathArgument,
  ErrFetchyTooManyAuthenticationAttempts,
} from '../errors.js'
import { FetchyRequest } from '../request.js'

describe('errors', () => {
  it.each([
    [
      'ErrFetchyInvalidDecoratorTarget',
      () => new ErrFetchyInvalidDecoratorTarget('API', 'a class'),
      'ERR_FETCHY_INVALID_DECORATOR_TARGET',
    ],
    [
      'ErrFetchyInvalidRoute',
      () => new ErrFetchyInvalidRoute('getUser', 'missing HTTP method'),
      'ERR_FETCHY_INVALID_ROUTE',
    ],
    ['ErrFetchyEmptyClient', () => new ErrFetchyEmptyClient('UsersAPI'), 'ERR_FETCHY_EMPTY_CLIENT'],
    ['ErrFetchyClientNotBuilt', () => new ErrFetchyClientNotBuilt('getUser'), 'ERR_FETCHY_CLIENT_NOT_BUILT'],
    [
      'ErrFetchyMissingPathArgument',
      () => new ErrFetchyMissingPathArgument('GET', '/users/{id}', 'id', undefined),
      'ERR_FETCHY_MISSING_PATH_ARGUMENT',
    ],
    [
      'ErrFetchyTooManyAuthenticationAttempts',
      () => new ErrFetchyTooManyAuthenticationAttempts(new FetchyRequest('GET', 'http://x.test', '/users/1'), 3),
      'ERR_FETCHY_TOO_MANY_AUTHENTICATION_ATTEMPTS',
    ],
    [
      'ErrFetchyFollowUpNotSent',
      () => new ErrFetchyFollowUpNotSent(new FetchyRequest('PUT', 'http://x.test', '/files/1'), 'body'),
      'ERR_FETCHY_FOLLOW_UP_NOT_SENT',
    ],
  ] as const)('%s has name and code aligned', (name, factory, code) => {
    const error = factory()

    expect(error.name).toBe(name)
    expect(error.code).toBe(code)
    // One base class lets a caller tell any fetchy failure from the rest with a single instanceof.
    expect(error).toBeInstanceOf(ErrFetchy)
  })

  it('ErrFetchyHTTP carries request/response details', () => {
    const request = new FetchyRequest('GET', 'http://x.test', '/users/1')
    const response = new Response(null, { status: 404, statusText: 'Not Found' })

    const error = new ErrFetchyHTTP(request, response, { message: 'not found' })

    expect(error.name).toBe('ErrFetchyHTTP')
    expect(error.code).toBe('ERR_FETCHY_HTTP')
    expect(error.status).toBe(404)
    expect(error.statusText).toBe('Not Found')
    expect(error.body).toEqual({ message: 'not found' })
    expect(error.request).toBe(request)
    expect(error.toJSON()).toMatchObject({ code: 'ERR_FETCHY_HTTP', status: 404 })
  })

  // An error message ends up in log lines, and so does every enumerable property of an error a logger serializes. A
  // query string often carries an API key, and a request body credentials, so neither may get there by default.
  it('ErrFetchyHTTP keeps the query string out of its message, and the request out of serialized properties', () => {
    const request = new FetchyRequest(
      'POST',
      'https://api.test',
      '/token?api_key=s3cr3t',
      undefined,
      'password=hunter2',
    )
    const response = new Response(null, { status: 401, statusText: 'Unauthorized' })

    const error = new ErrFetchyHTTP(request, response, undefined)

    expect(error.message).toBe('Request "POST https://api.test/token" failed with status 401 Unauthorized')
    expect(Object.keys(error)).not.toContain('request')
    expect(JSON.stringify(error)).not.toContain('s3cr3t')
    expect(JSON.stringify(Object.fromEntries(Object.entries(error)))).not.toContain('hunter2')
    expect(error.request.path).toBe('/token?api_key=s3cr3t')
  })

  // The message ends up in log lines, and a query string often carries an API key.
  it('ErrFetchyTooManyAuthenticationAttempts keeps the query string out of its message', () => {
    const request = new FetchyRequest('GET', 'https://api.test', '/users?api_key=s3cr3t')

    const error = new ErrFetchyTooManyAuthenticationAttempts(request, 3)

    expect(error.message.split('\n')[0]).toBe(
      'Cannot authenticate "GET https://api.test/users": the server answered all 3 follow-ups with 401, and fetchy sends no more',
    )
    expect(error.message).not.toContain('s3cr3t')
  })

  // The same holds for a follow-up fetchy refuses to send, whatever the reason.
  it.each([
    ['origin', 'it does not target "https://api.test"'],
    ['body', 'its body is a stream or an iterator, which the first send may have read'],
  ] as const)('ErrFetchyFollowUpNotSent keeps the query string out of its message about the %s', (problem, reason) => {
    const request = new FetchyRequest('PUT', 'https://api.test', '/files/1?api_key=s3cr3t')

    const error = new ErrFetchyFollowUpNotSent(request, problem)

    expect(error.message.split('\n')[0]).toBe(
      `Cannot send the authentication follow-up of "PUT https://api.test/files/1": ${reason}`,
    )
    expect(error.message).not.toContain('s3cr3t')
  })
})
