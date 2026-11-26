import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import {
  literalPrefix,
  normalizeGroupPath,
  normalizeLiteralPath,
  normalizeRoutePath,
  parseRoutePattern,
  pathsOf,
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

  // A matcher for another router reads the parts alone: a path the route syntax cannot read is refused, never repaired.
  it.each(['/items/:id([0-9]+', '/x/:a((b)'])('refuses %s, whose regex is not closed', pattern => {
    expect(() => parseRoutePattern(pattern)).toThrow(ErrConfiguration)
  })

  // find-my-way refuses a wildcard that is not last: refused here too, as a matcher for another router reads the same
  // text.
  it.each(['/a/*/b', '/a/*/', '/a/*/:id?'])('refuses %s, where a wildcard does not end the path', pattern => {
    expect(firstLine(() => parseRoutePattern(pattern))).toBe(
      `Cannot read the route path "${pattern}": a wildcard "*" must end the path`,
    )
  })

  it('refuses an unclosed regex in time linear in the path', () => {
    const started = performance.now()

    expect(() => parseRoutePattern('/' + ':id(('.repeat(20_000))).toThrow(ErrConfiguration)
    expect(performance.now() - started).toBeLessThan(1000)
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
    ['/files/*/', '/files/*'],
  ])('reads %j as %j', (path, expected) => {
    expect(normalizeGroupPath(path)).toBe(expected)
  })
})

describe('normalizeRoutePath', () => {
  // A route's trailing slash is part of the route: "/x/" and "/x" are different routes.
  it.each([
    ['x/', '/x/'],
    ['', '/'],
  ])('reads %j as %j', (path, expected) => {
    expect(normalizeRoutePath(path)).toBe(expected)
  })
})

describe.each([
  ['normalizeGroupPath', normalizeGroupPath],
  ['normalizeRoutePath', normalizeRoutePath],
])('%s', (_, normalize) => {
  // An empty segment is refused, never collapsed or kept: either would serve a route somewhere it was not written.
  it.each(['/a//b', '/api//', '//', '/a//:id?'])('refuses %j, which holds an empty segment', path => {
    expect(firstLine(() => normalize(path))).toBe(`Cannot use the path "${path}": it holds an empty segment, "//"`)
  })

  // A "//" inside a parameter's regex is part of the regex, not a segment boundary.
  it('accepts a "//" inside a parameter\'s regex', () => {
    expect(normalize('/d/:p(a//b)')).toBe('/d/:p(a//b)')
  })
})

describe('normalizeLiteralPath', () => {
  // A literal path is compared as text, so route syntax means nothing in it: a "//" is refused wherever it stands.
  it('refuses a "//" even where route syntax would read a regex', () => {
    expect(firstLine(() => normalizeLiteralPath('/a:x(//)'))).toBe(
      'Cannot use the path "/a:x(//)": it holds an empty segment, "//"',
    )
  })

  it('keeps a "*" as text', () => {
    expect(normalizeLiteralPath('/v*/x')).toBe('/v*/x')
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

describe('pathsOf', () => {
  // A route at "/" is its group's own path, answered with and without the trailing slash; any other keeps its own.
  it.each([
    ['', '/', false, ['/']],
    ['/r', '/', false, ['/r', '/r/']],
    ['/r', '/', true, ['/r']],
    ['/files/*', '/', false, ['/files/*']],
    ['/:id?', '/', false, ['/:id?']],
    ['/pets/:id?', '/', false, ['/pets/:id?', '/pets/:id?/']],
    ['/r', '/x/', false, ['/r/x/']],
  ])('registers %j with %j, ignoring trailing slashes %j, at %j', (base, routePath, ignore, expected) => {
    expect(pathsOf(base, routePath, ignore)).toEqual(expected)
  })
})

describe('routeURL', () => {
  // Plugins name a route's URL from raw configuration: each part is normalized as the server normalizes it.
  it.each([
    [undefined, '/', '/openapi.json', '/openapi.json'],
    ['/v1/', 'pets', '/', '/v1/pets'],
    [undefined, '/v1/', 'x/', '/v1/x/'],
  ])('joins %j, %j and %j as %j', (prefix, groupPath, routePath, expected) => {
    expect(routeURL(prefix, groupPath, routePath)).toBe(expected)
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
