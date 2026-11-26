import { ErrBrewPathParam } from '@caffeinejs/brewer'
import { describe, expect, it } from 'vitest'

import { newURL } from './index.js'

describe('newURL()', () => {
  it('substitutes path params into the template', () => {
    expect(newURL('/tasks/:id').param('id', '123').build()).toBe('http://localhost/tasks/123')
  })

  it('appends query params and honors a custom baseURL', () => {
    const url = newURL('/tasks/:id').param('id', 7).query('verbose', 'true').baseURL('http://api.test').build()

    expect(url).toBe('http://api.test/tasks/7?verbose=true')
  })

  // A gateway's base URL names the application's base path; resolving the path against it would drop that.
  it.each(['https://gw.example/api', 'https://gw.example/api/', 'https://gw.example/api//'])(
    'keeps the base path of %s',
    baseURL => {
      const url = newURL('/tasks/:id').param('id', 1).query('x', 1).baseURL(baseURL).build()

      expect(url).toBe('https://gw.example/api/tasks/1?x=1')
    },
  )

  // `newReq().path(newURL(...).build())` hands a full URL back in as the path; it goes on as it is.
  it('keeps a path that is already a full URL as it is', () => {
    expect(newURL('http://localhost/tasks/1').baseURL('https://gw.example/api').build()).toBe(
      'http://localhost/tasks/1',
    )
  })

  it('keeps a full URL as it is, its port included', () => {
    expect(newURL('http://localhost:3000/tasks/1').build()).toBe('http://localhost:3000/tasks/1')
  })

  // The route syntax, as the typed client fills it: what the router would match is what gets built.
  it.each([
    ['/pets/:id?', {}, '/pets'],
    ['/a::b/:id', { id: 1 }, '/a:b/1'],
    ['/at/:hour(^\\d{2})h', { hour: 12 }, '/at/12h'],
    ['/dash/*', { '*': 'a b/c' }, '/dash/a%20b/c'],
    ['/files*', { '*': 'a/b' }, '/filesa/b'],
    ['/rgx/:id(^(?:\\d+)$)', { id: 42 }, '/rgx/42'],
  ])('builds %s with %j as the route reads it', (path, params: Record<string, string | number>, pathname) => {
    const builder = newURL(path)
    for (const [name, value] of Object.entries(params)) {
      builder.param(name, value)
    }

    expect(new URL(builder.build()).pathname).toBe(pathname)
  })

  // Only the path is a template: a query is request data, sent as written, `*` and `:` included.
  it('fills the path of a template and keeps its query as written', () => {
    expect([
      newURL('/search?q=*').build(),
      newURL('/pets/:id?view=full').param('id', 7).build(),
      newURL('/pets/:id?').build(),
      newURL('/items/:id?/').build(),
    ]).toEqual([
      'http://localhost/search?q=*',
      'http://localhost/pets/7?view=full',
      'http://localhost/pets',
      'http://localhost/items/',
    ])
  })

  it('fills the path of a full URL template, keeping its host, port and query', () => {
    expect(newURL('https://api.test:8443/tasks/:id?x=1').param('id', 7).build()).toBe(
      'https://api.test:8443/tasks/7?x=1',
    )
  })

  it('throws ErrBrewPathParam when a param is absent', () => {
    expect(() => newURL('/tasks/:id').build()).toThrow(ErrBrewPathParam)
  })
})
