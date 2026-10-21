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
    expect(fillPath('/:a(' + '('.repeat(100_000) + '-:b', { a: 1, b: 2 })).toBe('/1')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  // Each path is read as find-my-way reads it: a name ends at `(`, `-` or `.`, a constraint runs to its balancing
  // `)`, text after it runs to the next single `:`, and `::` is a literal colon.
  it.each([
    ['/near/:lat-:lng', { lat: 1.5, lng: 2.5 }, '/near/1.5-2.5'],
    ['/files/:name.:ext', { name: 'report', ext: 'pdf' }, '/files/report.pdf'],
    ['/span/:from-:to-:step', { from: 1, to: 9, step: 2 }, '/span/1-9-2'],
    ['/ver/:major.:minor.:patch', { major: 1, minor: 2, patch: 3 }, '/ver/1.2.3'],
    ['/mixed/:a-:b.:c', { a: 'x', b: 'y', c: 'z' }, '/mixed/x-y.z'],
    ['/at/:hour(^\\d{2})h:minute(^\\d{2})m', { hour: '08', minute: '24' }, '/at/08h24m'],
    ['/pair/:a(^\\d+)-:b', { a: 12, b: 'x' }, '/pair/12-x'],
    ['/two/:a(^\\d+)-:b(^\\d+)', { a: 1, b: 2 }, '/two/1-2'],
    ['/esc/:id(^\\(x$)-:b', { id: '(x', b: 'y' }, '/esc/(x-y'],
    ['/nest/:id(^((\\d)+)$)-:b', { id: 12, b: 'y' }, '/nest/12-y'],
    ['/doc/:name.json', { name: 'report' }, '/doc/report.json'],
    ['/api/v:version', { version: 2 }, '/api/v2'],
    ['/item/item-:id.json', { id: 7 }, '/item/item-7.json'],
    ['/radius/:lat-:lng/r/:r', { lat: 1, lng: 2, r: 3 }, '/radius/1-2/r/3'],
    ['/opt/:lat-:lng?', { lat: 1, lng: 2 }, '/opt/1-2'],
    ['/rgx/:id(^(?:\\d+)$)', { id: 42 }, '/rgx/42'],
    ['/esc/a::b/:id', { id: 7 }, '/esc/a:b/7'],
    ['/doc/:name.v::1', { name: 'report' }, '/doc/report.v%3A1'],
    ['/tail/:id-:rev/*', { id: 7, rev: 3, '*': 'a/b' }, '/tail/7-3/a/b'],
    ['/k/:lat:lng', { 'lat:lng': 'x' }, '/k/x'],
  ])('fills %s, keeping the text beside each parameter', (path, params, expected) => {
    expect(fillPath(path, params)).toBe(expected)
  })

  it('encodes each value of a shared segment on its own, and leaves the text between them alone', () => {
    expect(fillPath('/near/:lat-:lng', { lat: 'a b', lng: 'ø' })).toBe('/near/a%20b-%C3%B8')
    expect(fillPath('/files/:name.:ext', { name: '?#%', ext: 'a/b' })).toBe('/files/%3F%23%25.a%2Fb')
  })

  it('names the one parameter of a shared segment that has no value', () => {
    const error = thrown(() => fillPath('/near/:lat-:lng', { lat: 1 }))

    expect(error).toBeInstanceOf(ErrBrewPathParam)
    expect(error.message.split('\n')[0]).toBe(
      'Cannot build a request for "/near/:lat-:lng": no value for path parameter "lng"',
    )
    expect(() => fillPath('/span/:from-:to-:step', { from: 1, to: 9 })).toThrow('path parameter "step"')
    expect(() => fillPath('/at/:hour(^\\d{2})h:minute(^\\d{2})m', { minute: 24 })).toThrow('path parameter "hour"')
  })

  it('drops an optional shared segment given no value, and requires the rest once one is given', () => {
    expect(fillPath('/opt/:lat-:lng?', {})).toBe('/opt')
    expect(fillPath('/opt/:lat-:lng?', { lat: null, lng: undefined })).toBe('/opt')
    expect(fillPath('/opt/:lat-:lng?', undefined)).toBe('/opt')
    expect(() => fillPath('/opt/:lat-:lng?', { lat: 1 })).toThrow('path parameter "lng"')
    expect(() => fillPath('/opt/:lat-:lng?', { lng: 2 })).toThrow('path parameter "lat"')
  })

  it('refuses . or .. as the value of a parameter that shares its segment', () => {
    const error = thrown(() => fillPath('/files/:name.:ext', { name: '..', ext: 'pdf' }))

    expect(error).toBeInstanceOf(ErrBrewPathValue)
    expect(error.message.split('\n')[0]).toBe(
      'Cannot build a request for "/files/:name.:ext": path parameter "name" is "..", which a URL resolves as a step along the path',
    )
    expect(() => fillPath('/near/:lat-:lng', { lat: 1, lng: '.' })).toThrow(ErrBrewPathValue)
  })

  it('refuses a shared segment that its values fill as . or .., which a URL would resolve the same way', () => {
    const error = thrown(() => fillPath('/files/:name.:ext', { name: '', ext: '' }))

    expect(error).toBeInstanceOf(ErrBrewPathValue)
    expect(error).toMatchObject({ name: 'ErrBrewPathValue', code: 'ERR_BREW_PATH_VALUE' })
    expect(error.message.split('\n')[0]).toBe(
      'Cannot build a request for "/files/:name.:ext": segment ":name.:ext" is "." once filled, which a URL resolves as a step along the path',
    )
    expect(error.message).toContain('Refuse empty values before the call, or send them in the query or the body')
    expect(() => fillPath('/ver/:major.:minor.:patch', { major: '', minor: '', patch: '' })).toThrow(
      'segment ":major.:minor.:patch" is ".." once filled',
    )
    expect(() => fillPath('/x/:a..:b', { a: '', b: '' })).toThrow('segment ":a..:b" is ".." once filled')
  })

  it('sends a shared segment holding an empty value when it does not fill as a step', () => {
    expect(fillPath('/files/:name.:ext', { name: '', ext: 'pdf' })).toBe('/files/.pdf')
    expect(fillPath('/files/:name.:ext', { name: 'a', ext: '' })).toBe('/files/a.')
    expect(fillPath('/near/:lat-:lng', { lat: '', lng: '' })).toBe('/near/-')
  })

  it('reads a trailing ? as optional only on a segment that starts with its parameter and holds no constraint', () => {
    expect(fillPath('/x/:name.json?', {})).toBe('/x')
    expect(fillPath('/x/:name.json?', { name: 'a' })).toBe('/x/a.json')
    expect(fillPath('/item/item-:id?', { 'id?': 7 })).toBe('/item/item-7')
    expect(() => fillPath('/item/item-:id?', {})).toThrow('path parameter "id?"')
    expect(fillPath('/api/v:version?', { 'version?': 2 })).toBe('/api/v2')
    expect(() => fillPath('/api/v:version?', {})).toThrow('path parameter "version?"')
    expect(fillPath('/two/:a(^\\d+)-:b?', { a: 1, 'b?': 2 })).toBe('/two/1-2')
  })

  // The router reads a `?` after a constraint as text, so it is sent escaped rather than starting the query.
  it('sends the ? that follows a constraint as text, and requires the parameter before it', () => {
    expect(fillPath('/tags/:id(^\\d+)?', { id: 42 })).toBe('/tags/42%3F')
    expect(() => fillPath('/tags/:id(^\\d+)?', {})).toThrow('path parameter "id"')
  })

  // find-my-way 9.9.0 matches text after a parameter against the decoded segment, its `%` stored doubled, and text
  // before the first parameter as a static node, which a `%25` reaches.
  it('escapes the text beside a parameter as the router matches it', () => {
    expect(fillPath('/near/:a-%:b', { a: 1, b: 2 })).toBe('/near/1-%25252')
    expect(fillPath('/h/:a-#:b', { a: 1, b: 2 })).toBe('/h/1-%232')
    expect(fillPath('/x/100%-:id', { id: 7 })).toBe('/x/100%25-7')
    expect(fillPath('/p/x+-:id', { id: 7 })).toBe('/p/x+-7')
    expect(fillPath('/p/v::1-:id', { id: 7 })).toBe('/p/v:1-7')
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
