import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { boundTo } from '../../../binding.js'
import { bindTo } from '../../../decorators/bind_to.js'
import { stateOf, type RouterState } from './_state.js'
import { flattenRouter } from './flatten.js'
import { Router } from './programmatic.js'

describe('default route names', () => {
  it('ignores long malformed constraints without retrying at every parenthesis', () => {
    const router = new Router('/pets').get('/:id' + '('.repeat(100_000) + '\nx', () => undefined)
    const started = performance.now()
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].spec.routes[0].name).toBe('get_id')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('keeps parameter, optional and wildcard names stable', () => {
    const router = new Router('/pets')
      .get('/:id(^\\d+$)', () => undefined)
      .post('/:name?', () => undefined)
      .delete('/*', () => undefined)
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].name).toBe('Pets')
    expect(groups[0].spec.routes.map(route => route.name)).toEqual(['get_id', 'post_name', 'delete_all'])
  })

  // Read as the router reads the segment: every parameter by its name, its marker and constraint dropped, and the
  // text beside it kept, so routes that differ only in that text keep names of their own.
  it.each([
    ['/near/:lat-:lng', 'get_near_lat-lng'],
    ['/files/:name.:ext', 'get_files_name.ext'],
    ['/span/:from-:to-:step', 'get_span_from-to-step'],
    ['/at/:hour(^\\d{2})h:minute(^\\d{2})m', 'get_at_hourhminutem'],
    ['/pair/:a(^\\d+)-:b', 'get_pair_a-b'],
    ['/two/:a(^\\d+)-:b(^\\d+)', 'get_two_a-b'],
    ['/esc/:id(^\\(x$)-:b', 'get_esc_id-b'],
    ['/doc/:name.json', 'get_doc_name.json'],
    ['/api/v:version', 'get_api_vversion'],
    ['/item/item-:id.json', 'get_item_item-id.json'],
    ['/opt/:lat-:lng?', 'get_opt_lat-lng'],
    ['/rgx/:id(^(?:\\d+)$)', 'get_rgx_id'],
    ['/esc/a::b/:id', 'get_esc_a:b_id'],
    ['/tail/:id-:rev/*', 'get_tail_id-rev_all'],
    ['/k/:lat:lng', 'get_k_lat:lng'],
  ])('names %s %s', (path, name) => {
    const groups = flattenRouter(stateOf(new Router('/').get(path, () => undefined))!, new CaffeineIoC())
    expect(groups[0].spec.routes[0].name).toBe(name)
  })

  it('names a group after every parameter its path holds', () => {
    const router = new Router('/geo/:lat-:lng').get('/', () => undefined)
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].name).toBe('GeoLat-lng')
  })

  it('keeps apart routes that differ only in the text beside a parameter', () => {
    const router = new Router('/doc').get('/:name.json', () => undefined).get('/:name.xml', () => undefined)
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].spec.routes.map(route => route.name)).toEqual(['get_name.json', 'get_name.xml'])
  })

  it('reads a second parameter after a long malformed constraint without retrying at every parenthesis', () => {
    const router = new Router('/pets').get('/:a(' + '('.repeat(100_000) + '-:b', () => undefined)
    const started = performance.now()
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].spec.routes[0].name).toBe('get_a')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

/**
 * A router tree has one binding: a nested router is served where the router it is nested in is, and saying otherwise
 * is refused rather than silently dropped by the merge.
 */
describe('binding a nested router', () => {
  const bindings = (router: object) =>
    flattenRouter(stateOf(router)!, new CaffeineIoC()).map(group => [group.name, boundTo(group.spec.labels)])

  it('serves a nested router where its parent is', () => {
    const ops = new Router('/ops').extend(bindTo('admin')).group('/jobs', jobs => jobs.get('/', () => undefined))

    expect(bindings(ops)).toEqual([['OpsJobs', 'admin']])
  })

  it('accepts a nested router repeating its parent binding', () => {
    const ops = new Router('/ops')
      .extend(bindTo('admin'))
      .group('/jobs', jobs => jobs.extend(bindTo('admin')).get('/', () => undefined))

    expect(bindings(ops)).toEqual([['OpsJobs', 'admin']])
  })

  it('refuses a nested router bound to another server, naming both routers', () => {
    const ops = new Router('/ops')
      .extend(bindTo('admin'))
      .get('/', () => undefined)
      .group('/jobs', jobs => jobs.extend(bindTo('metrics')).get('/', () => undefined))

    expect(() => bindings(ops)).toThrow(
      /^Cannot nest router "OpsJobs" in "Ops": it is bound to "metrics", and "Ops" to "admin"/,
    )
  })

  it('lets a router nested in an unbound router bind itself', () => {
    const api = new Router('/api')
      .get('/', () => undefined)
      .group('/ops', ops => ops.extend(bindTo('admin')).get('/', () => undefined))

    expect(bindings(api)).toEqual([
      ['Api', undefined],
      ['ApiOps', 'admin'],
    ])
  })

  it('serves a router shared by a bound and an unbound parent in each place it lands', () => {
    const shared = new Router('/shared').get('/', () => undefined)
    const ops = new Router('/ops').extend(bindTo('admin')).mount(shared)
    const api = new Router('/api').mount(shared)

    expect(bindings(ops)).toEqual([['OpsShared', 'admin']])
    expect(bindings(api)).toEqual([['ApiShared', undefined]])
  })
})

/**
 * A router nested in itself, by `.mount(...)` or by a plugin's `context.app.mount(...)`, would nest without end: the
 * walk refuses it, naming the loop, rather than running out of stack.
 */
describe('a router nested in itself', () => {
  const flatten = (router: object, childrenOf?: (state: RouterState) => readonly RouterState[]) =>
    flattenRouter(stateOf(router)!, new CaffeineIoC(), childrenOf)

  it('refuses a router mounted in itself', () => {
    const loop = new Router('/loop').get('/', () => undefined)
    loop.mount(loop)

    expect(() => flatten(loop)).toThrow(/^Cannot nest router "\/loop" in itself: "\/loop" → "\/loop"/)
  })

  it('refuses a loop through another router, naming every router on it', () => {
    const a = new Router('/a').get('/', () => undefined)
    const b = new Router('/b').get('/', () => undefined)
    a.mount(b)
    b.mount(a)

    expect(() => flatten(a)).toThrow(/^Cannot nest router "\/a" in itself: "\/a" → "\/b" → "\/a"/)
  })

  // What a router's plugin mounts reaches the walk through `childrenOf`, never through `.mount(...)`.
  it('refuses a loop closed only by what a plugin mounted', () => {
    const a = new Router('/a').get('/', () => undefined)
    const b = new Router('/b').get('/', () => undefined)
    a.mount(b)
    const childrenOf = (state: RouterState) => (state === stateOf(b) ? [stateOf(a)!] : state.children)

    expect(() => flatten(a, childrenOf)).toThrow(/^Cannot nest router "\/a" in itself: "\/a" → "\/b" → "\/a"/)
  })

  it('names a router by the name it was given, and one with no path as "/"', () => {
    const named = new Router('/named').name('Loop').get('/', () => undefined)
    named.mount(named)
    const bare = new Router().get('/', () => undefined)
    bare.mount(bare)

    expect(() => flatten(named)).toThrow(/^Cannot nest router "Loop" in itself: "Loop" → "Loop"/)
    expect(() => flatten(bare)).toThrow(/^Cannot nest router "\/" in itself: "\/" → "\/"/)
  })

  // Only the routers above it count: the same router twice along one branch, at different depths, is two places.
  it('serves the same router at two depths of one branch', () => {
    const leaf = new Router('/leaf').get('/', () => undefined)
    const inner = new Router('/inner').mount(leaf)
    const outer = new Router('/outer').mount(inner, leaf)

    expect(flatten(outer).map(group => group.name)).toEqual(['OuterInnerLeaf', 'OuterLeaf'])
  })
})

/** A route's name is its identity in its group, and what the OpenAPI operation id is built from. */
describe('route names', () => {
  const flatten = (router: object) => flattenRouter(stateOf(router)!, new CaffeineIoC())

  it('refuses two routes of one group given the same name', () => {
    const pets = new Router('/pets')
    pets
      .get('/')
      .name('list')
      .handler(() => undefined)
    pets
      .get('/all')
      .name('list')
      .handler(() => undefined)

    expect(() => flatten(pets)).toThrow(/^Duplicate route name "list" in "Pets"/)
  })

  it('refuses two routes whose default names collide', () => {
    const pets = new Router('/pets')
      .route(['GET', 'POST'], '/ping', () => undefined)
      .route(['PUT', 'PATCH'], '/ping', () => undefined)

    expect(() => flatten(pets)).toThrow(/^Duplicate route name "any_ping" in "Pets"/)
  })

  // Names are unique per group, and a nested group is a group of its own.
  it('lets a nested group reuse a name its parent gave', () => {
    const pets = new Router('/pets')
    pets
      .get('/')
      .name('list')
      .handler(() => undefined)
    pets.group('/archived', archived => {
      archived
        .get('/')
        .name('list')
        .handler(() => undefined)
    })

    expect(flatten(pets).map(group => group.name)).toEqual(['Pets', 'PetsArchived'])
  })
})
