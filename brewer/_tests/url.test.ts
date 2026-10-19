import { describe, expect, it } from 'vitest'

import { ErrBrewPathParam, ErrBrewPathValue, buildQuery, fillPath, joinURL } from '../index.js'

function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }

  throw new Error('expected a throw')
}

describe('fillPath', () => {
  it('returns a path that declares no parameter as it is', () => {
    expect(fillPath('/pets/search', undefined)).toBe('/pets/search')
  })

  it('fills each parameter, a constrained one and nested ones included', () => {
    expect(fillPath('/:id(^\\d+$)', { id: 42 })).toBe('/42')
    expect(fillPath('/pets/:petID/orders/:orderID', { petID: 'a b', orderID: 'ø' })).toBe('/pets/a%20b/orders/%C3%B8')
  })

  it('places an optional parameter when given and drops it when not', () => {
    expect(fillPath('/pets/:id?', { id: 7 })).toBe('/pets/7')
    expect(fillPath('/pets/:id?', {})).toBe('/pets')
    expect(fillPath('/pets/:id?', { id: null })).toBe('/pets')
    expect(fillPath('/pets/:id?', undefined)).toBe('/pets')
  })

  it('keeps the slashes of a wildcard and encodes every part between them', () => {
    expect(fillPath('/assets/*', { '*': 'a/b' })).toBe('/assets/a/b')
    expect(fillPath('/assets/*', { '*': 'a b/c?d#e%' })).toBe('/assets/a%20b/c%3Fd%23e%25')
  })

  it('requires a wildcard like any other parameter', () => {
    expect(fillPath('/assets/*', { '*': '' })).toBe('/assets/')
    expect(() => fillPath('/assets/*', {})).toThrow(ErrBrewPathParam)
  })

  it('says which parameter has no value, in which path, and how to give it', () => {
    const error = thrown(() => fillPath('/pets/:id', {}))

    expect(error).toBeInstanceOf(ErrBrewPathParam)
    expect(error).toMatchObject({ name: 'ErrBrewPathParam', code: 'ERR_BREW_PATH_PARAM' })
    expect(error.message.split('\n')[0]).toBe(
      'Cannot build a request for "/pets/:id": no value for path parameter "id"',
    )
    expect(error.message).toContain('Pass it in the request init: { params: { "id": value } }')
  })

  it('refuses a value of . or .., which a URL would resolve as a step along the path', () => {
    const error = thrown(() => fillPath('/pets/:id', { id: '..' }))

    expect(error).toBeInstanceOf(ErrBrewPathValue)
    expect(error).toMatchObject({ name: 'ErrBrewPathValue', code: 'ERR_BREW_PATH_VALUE' })
    expect(error.message.split('\n')[0]).toBe(
      'Cannot build a request for "/pets/:id": path parameter "id" is "..", which a URL resolves as a step along the path',
    )
    expect(error.message).toContain('Refuse the value before the call, or send it in the query or the body')
    expect(() => fillPath('/pets/:id', { id: '.' })).toThrow(ErrBrewPathValue)
  })

  it('finds the parameter before a long malformed constraint', () => {
    const started = performance.now()
    expect(fillPath('/:id' + '('.repeat(100_000) + '\nx', { id: 'a/b' })).toBe('/a%2Fb')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('buildQuery', () => {
  it.each([
    ['no query', undefined, ''],
    ['a null query', null, ''],
    ['an empty query', {}, ''],
    ['a query whose every value is left out', { a: undefined, b: null, c: [] }, ''],
    ['one value', { q: 'rex' }, '?q=rex'],
    ['0 and false', { limit: 0, archived: false }, '?limit=0&archived=false'],
    ['a list, its empty items left out', { tag: ['a', null, 'b', undefined] }, '?tag=a&tag=b'],
    ['reserved characters', { 'q&': 'a&b=c d+e' }, '?q%26=a%26b%3Dc+d%2Be'],
  ])('renders %s', (_case, query, expected) => {
    expect(buildQuery(query)).toBe(expected)
  })
})

// Joined, never resolved: `new URL('/pets', 'https://gw.example/api')` is `https://gw.example/pets`, and a base URL
// naming the application's base path has to keep it.
describe('joinURL', () => {
  it.each([
    ['https://gw.example/api', '/pets/7', 'https://gw.example/api/pets/7'],
    ['https://gw.example/api/', '/pets/7', 'https://gw.example/api/pets/7'],
    ['https://gw.example/api', '/', 'https://gw.example/api'],
    ['https://gw.example/api', '', 'https://gw.example/api'],
    ['https://gw.example/api', 'pets', 'https://gw.example/api/pets'],
    ['https://gw.example', '/pets', 'https://gw.example/pets'],
    ['/api', '/pets', '/api/pets'],
    ['', '/pets', '/pets'],
  ])('should join %j and %j into %j', (baseURL, path, expected) => {
    expect(joinURL(baseURL, path)).toBe(expected)
  })
})
