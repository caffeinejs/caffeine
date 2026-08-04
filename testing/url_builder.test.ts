import { describe, expect, it } from 'vitest'
import { ErrMissingRouteParam, newURL } from './index.js'

describe('newURL()', () => {
  it('substitutes path params into the template', () => {
    expect(newURL('/tasks/:id').param('id', '123').build()).toBe('http://localhost/tasks/123')
  })

  it('appends query params and honors a custom baseURL', () => {
    const url = newURL('/tasks/:id')
      .param('id', 7)
      .query('verbose', 'true')
      .baseURL('http://api.test')
      .build()

    expect(url).toBe('http://api.test/tasks/7?verbose=true')
  })

  it('throws ErrMissingRouteParam when a param is absent', () => {
    expect(() => newURL('/tasks/:id').build()).toThrow(ErrMissingRouteParam)
  })
})
