import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import {
  literalPrefix,
  joinRoutePath,
  normalizeGroupPath,
  normalizeLiteralPath,
  normalizeRoutePath,
  parseRoutePattern,
  routeKeys,
  routePathSegments,
  routeURL,
  underPrefix,
} from './paths.js'

const text = (text: string) => ({ kind: 'text', text })
const param = (name: string, regex?: string) => ({ kind: 'param', name, regex })
const wildcard = { kind: 'wildcard' }
const optional = { kind: 'optional' }

describe('parseRoutePattern', () => {
  // A caller reading a route path must split it as the route syntax does, or literal text would be read as part of a
  // parameter's name, and a "/" in a regex as a segment boundary.
  it.each([
    ['/users/:id', [text('/users/'), param('id')]],
    [
      '/at/:hour(^\\d{2})h:minute(^\\d{2})m',
      [text('/at/'), param('hour', '^\\d{2}'), text('h'), param('minute', '^\\d{2}'), text('m')],
    ],
    ['/x/:a-:b.json', [text('/x/'), param('a'), text('-'), param('b'), text('.json')]],
    ['/teams/:$team([a-z]+)', [text('/teams/'), param('$team', '[a-z]+')]],
    ['/d/:p((a|b)/\\))/x', [text('/d/'), param('p', '(a|b)/\\)'), text('/x')]],
    ['/service::name', [text('/service:name')]],
    ['/files/*', [text('/files/'), wildcard]],
    // After a parameter, a "*" is text up to the next segment.
    ['/download/:id-file*name', [text('/download/'), param('id'), text('-file*name')]],
    ['/d/:id/*', [text('/d/'), param('id'), text('/'), wildcard]],
    // An optional last segment: what follows the mark may be absent, the "/" that starts the segment included.
    ['/items/:id?', [text('/items'), optional, text('/'), param('id')]],
    ['/items/:id?/', [text('/items'), optional, text('/'), param('id'), text('/')]],
    ['/:id?', [optional, text('/'), param('id')]],
    ['/opt/:lat-:lng?', [text('/opt'), optional, text('/'), param('lat'), text('-'), param('lng')]],
    ['/reports/:id.json?', [text('/reports'), optional, text('/'), param('id'), text('.json')]],
    ['/:tenant/::summary?', [text('/'), param('tenant'), optional, text('/:summary')]],
    // Not optional: a "?" anywhere else is part of the name, and a segment holding a regex is never optional.
    ['/r/:id(\\d+)-:x?', [text('/r/'), param('id', '\\d+'), text('-'), param('x?')]],
    ['/item-:id?', [text('/item-'), param('id?')]],
    ['/items/:id?/x', [text('/items/'), param('id?'), text('/x')]],
  ])('splits %s as the route syntax reads it', (pattern, parts) => {
    expect(parseRoutePattern(pattern)).toEqual(parts)
  })

  // An unclosed regex runs to the end of the path: the router refuses it when the route registers.
  it('reads an unclosed regex to the end of the path', () => {
    expect(parseRoutePattern('/a/:id(\\d+')).toEqual([text('/a/'), param('id', '\\d+')])
  })
})

describe('routePathSegments', () => {
  // A request to a route under the path starts with this many segments, whatever its parameters hold: a caller takes
  // them off to read what follows.
  it.each([
    ['', 0],
    ['/tenants/:id', 2],
    ['/at/:hour(^\\d{2})h', 2],
    ['/d/:p((a|b)/c)', 2],
    ['/v2/', 2],
  ])('counts %j as %i segments', (path, segments) => {
    expect(routePathSegments(path)).toBe(segments)
  })
})

describe('normalizeGroupPath', () => {
  // Group paths join by plain concatenation: each must be rooted and end without a "/", or the join doubles a slash.
  it.each([
    ['api', '/api'],
    ['/api/', '/api'],
    ['/', ''],
    ['', ''],
    ['//catalog', '/catalog'],
    ['/t/:id(\\d+)', '/t/:id(\\d+)'],
  ])('reads %j as %j', (path, expected) => {
    expect(normalizeGroupPath(path)).toBe(expected)
  })

  // A router, group, controller or mount path is simple: what a wildcard or an optional segment would leave below it
  // is not a path a route or a middleware can start from.
  it.each(['/files/*', '/pets/:id?'])('refuses %j, which holds a wildcard or an optional segment', path => {
    expect(firstLine(() => normalizeGroupPath(path))).toBe(
      `Cannot use "${path}" as a router path: it holds a wildcard or an optional segment`,
    )
  })
})

describe('normalizeRoutePath', () => {
  // A trailing slash never makes another route: "/x/" and "/x" are one route.
  it.each([
    ['x/', '/x'],
    ['/pets/', '/pets'],
    ['', '/'],
    ['/', '/'],
  ])('reads %j as %j', (path, expected) => {
    expect(normalizeRoutePath(path)).toBe(expected)
  })
})

describe('normalizeLiteralPath', () => {
  // A leading "//" names another host to a browser: a run of leading slashes is read as one.
  it.each([
    ['//catalog', '/catalog'],
    ['///a/', '/a'],
    ['/v*/x', '/v*/x'],
  ])('reads %j as %j', (path, expected) => {
    expect(normalizeLiteralPath(path)).toBe(expected)
  })
})

describe('literalPrefix', () => {
  it.each([
    ['/a/', { exact: '/a', under: '/a/' }],
    ['/', { exact: '', under: '/' }],
  ])('reads %j as %j', (path, expected) => {
    expect(literalPrefix(path)).toEqual(expected)
  })
})

describe('underPrefix', () => {
  // A prefix covers whole segments: "/a" must not cover "/ab".
  it.each([
    ['/a', true],
    ['/a/b', true],
    ['/ab', false],
  ])('reads %j under "/a" as %j', (path, expected) => {
    expect(underPrefix(path, literalPrefix('/a'))).toBe(expected)
  })
})

describe('joinRoutePath', () => {
  // A route at "/" is its group's own path.
  it.each([
    ['', '/', '/'],
    ['/r', '/', '/r'],
    ['/r', '/x', '/r/x'],
  ])('joins %j and %j as %j', (base, routePath, expected) => {
    expect(joinRoutePath(base, routePath)).toBe(expected)
  })
})

describe('routeURL', () => {
  // Plugins name a route's URL from raw configuration: each part is normalized as the server normalizes it.
  it.each([
    [undefined, '/', '/openapi.json', '/openapi.json'],
    ['/v1/', 'pets', '/', '/v1/pets'],
    [undefined, '/v1/', 'x/', '/v1/x'],
  ])('joins %j, %j and %j as %j', (prefix, groupPath, routePath, expected) => {
    expect(routeURL(prefix, groupPath, routePath)).toBe(expected)
  })
})

describe('routeKeys', () => {
  // The router files a parameter by its place and its regex, not its name.
  it('gives two paths differing only in parameter names one key', () => {
    expect(routeKeys('/t/:id')).toEqual(routeKeys('/t/:tid'))
  })

  it('tells a parameter apart from one with a regex, and from an escaped colon', () => {
    const [plain] = routeKeys('/t/:id')
    expect([routeKeys('/t/:id(\\d+)')[0] === plain, routeKeys('/t/::id')[0] === plain]).toEqual([false, false])
  })

  // find-my-way trims a regex's leading "^" and trailing "$" before it files the parameter.
  it('gives a regex with and without its anchors one key', () => {
    expect(routeKeys('/t/:id(^\\d+$)')).toEqual(routeKeys('/t/:x(\\d+)'))
  })

  // A route with an optional last segment answers at both forms.
  it('gives a path with an optional last segment the key of each form', () => {
    expect(routeKeys('/t/:id?')).toEqual([...routeKeys('/t/:x'), ...routeKeys('/t')])
    expect(routeKeys('/:id?')).toEqual([...routeKeys('/:x'), ...routeKeys('/')])
  })
})

function firstLine(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ErrConfiguration)
    return (err as Error).message.split('\n')[0]!
  }

  throw new Error('expected a throw')
}
