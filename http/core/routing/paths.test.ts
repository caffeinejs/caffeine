import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { parseRoutePattern, routePathSegments } from './paths.js'

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
    ['', {}, 0],
    ['/tenants/:id', {}, 2],
    ['/at/:hour(^\\d{2})h', {}, 2],
    ['/d/:p((a|b)/c)', {}, 2],
    ['/v2/', {}, 2],
    ['/v2/', { ignoreDuplicateSlashes: true }, 1],
    ['/a//b', { ignoreDuplicateSlashes: true }, 2],
  ])('counts %j under %j as %i segments', (path, flags, segments) => {
    expect(routePathSegments(path, flags)).toBe(segments)
  })
})
