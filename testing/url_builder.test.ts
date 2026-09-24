import { describe, expect, it } from 'vitest'

import { ErrMissingRouteParam, newURL } from './index.js'

describe('newURL()', () => {
  it('substitutes path params into the template', () => {
    expect(newURL('/tasks/:id').param('id', '123').build()).toBe('http://localhost/tasks/123')
  })

  it('appends query params and honors a custom baseURL', () => {
    const url = newURL('/tasks/:id').param('id', 7).query('verbose', 'true').baseURL('http://api.test').build()

    expect(url).toBe('http://api.test/tasks/7?verbose=true')
  })

  // A gateway's base URL names the application's base path; resolving the path against it would drop that.
  it.each(['https://gw.example/api', 'https://gw.example/api/'])('keeps the base path of %s', baseURL => {
    const url = newURL('/tasks/:id').param('id', 1).query('x', 1).baseURL(baseURL).build()

    expect(url).toBe('https://gw.example/api/tasks/1?x=1')
  })

  // `newReq().path(newURL(...).build())` hands a full URL back in as the path; it goes on as it is.
  it('keeps a path that is already a full URL as it is', () => {
    expect(newURL('http://localhost/tasks/1').baseURL('https://gw.example/api').build()).toBe(
      'http://localhost/tasks/1',
    )
  })

  it('throws ErrMissingRouteParam when a param is absent', () => {
    expect(() => newURL('/tasks/:id').build()).toThrow(ErrMissingRouteParam)
  })
})
