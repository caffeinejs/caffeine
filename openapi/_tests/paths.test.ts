import { describe, expect, it } from 'vitest'

import { joinPaths, routeURL, templateParameters, translatePath } from '../generate/paths.js'

describe('translatePath', () => {
  it('leaves a static path alone', () => {
    expect(translatePath('/pets')).toEqual({ templates: ['/pets'], parameters: [] })
  })

  it('rewrites a named parameter', () => {
    expect(translatePath('/pets/:id')).toEqual({
      templates: ['/pets/{id}'],
      parameters: [{ name: 'id', pattern: undefined }],
    })
  })

  it('rewrites several parameters across segments', () => {
    const result = translatePath('/users/:userId/orders/:orderId')

    expect(result.templates).toEqual(['/users/{userId}/orders/{orderId}'])
    expect(result.parameters.map(p => p.name)).toEqual(['userId', 'orderId'])
  })

  it('splits two parameters sharing one segment', () => {
    const result = translatePath('/files/:file.:ext')

    expect(result.templates).toEqual(['/files/{file}.{ext}'])
    expect(result.parameters.map(p => p.name)).toEqual(['file', 'ext'])
  })

  it('lifts an inline regex onto the parameter and strips its anchors', () => {
    const result = translatePath('/pets/:id(^\\d+$)')

    expect(result.templates).toEqual(['/pets/{id}'])
    expect(result.parameters).toEqual([{ name: 'id', pattern: '\\d+' }])
  })

  it('emits two templates for an optional parameter', () => {
    const result = translatePath('/pets/:id?')

    expect(result.templates).toEqual(['/pets', '/pets/{id}'])
    expect(result.parameters.map(p => p.name)).toEqual(['id'])
  })

  it('renames a wildcard, which is not a legal template name', () => {
    const result = translatePath('/assets/*')

    expect(result.templates).toEqual(['/assets/{wildcard}'])
    expect(result.parameters).toEqual([{ name: 'wildcard', wildcard: true }])
  })
})

describe('templateParameters', () => {
  it('reads the names a template references, in order', () => {
    expect(templateParameters('/users/{userId}/orders/{orderId}')).toEqual(['userId', 'orderId'])
  })

  it('is empty for a static template', () => {
    expect(templateParameters('/pets')).toEqual([])
  })
})

describe('routeURL', () => {
  it('joins prefix, router path and route path the way the adapter does', () => {
    expect(routeURL(undefined, '/pets', '/')).toBe('/pets')
    expect(routeURL(undefined, '/pets', '/:id')).toBe('/pets/:id')
    expect(routeURL('/api', '/pets', '/')).toBe('/api/pets')
  })
})

// This is a deliberate copy of http's internal `joinPaths`, which is not exported and which the project's
// no-passthrough rule forbids re-exporting. The table pins the behaviour being copied: if http's version ever
// changes, these expectations are the record of what openapi assumed and the place the divergence surfaces.
describe('joinPaths', () => {
  const cases: Array<[string, string, string]> = [
    ['', '', '/'],
    ['', '/', '/'],
    ['/', '/', '/'],
    ['/pets', '/', '/pets'],
    ['/pets', '', '/pets'],
    ['/pets', '/:id', '/pets/:id'],
    ['/pets', '/:id/', '/pets/:id'],
    ['', '/pets', '/pets'],
    ['/a/', '/b', '/a//b'],
    ['/a', '/b/c/', '/a/b/c'],
  ]

  it.each(cases)('joinPaths(%o, %o) === %o', (base, path, expected) => {
    expect(joinPaths(base, path)).toBe(expected)
  })
})
