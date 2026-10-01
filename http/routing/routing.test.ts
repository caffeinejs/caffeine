import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'

import { bindTo } from '../decorators/bind_to.js'
import { RouteBuilder, RouteGroupBuilder } from './builder.js'
import { buildRouting, type DeclaredRouteGroup, type RouteSource } from './routing.js'
import type { RouteGroupSpec } from './spec.js'

/**
 * Which server serves a group is decided by selecting on the group's labels, once, before anything compiles: a
 * source only declares, so no source can serve a group twice, or resolve what a group needs for a server that never
 * selects it.
 */

const kTier = Symbol('tier')

function declared(name: string, configure?: (group: RouteGroupBuilder) => void) {
  const builder = new RouteGroupBuilder().path(`/${name}`).routes([
    new RouteBuilder()
      .method('GET')
      .path('/')
      .handle(() => ({})),
  ])
  configure?.(builder)

  const meta = vi.fn(() => ({ name }))
  const group: DeclaredRouteGroup<unknown> = { name, spec: builder.toRouteGroup(), meta }

  return { group, meta }
}

function source(...groups: DeclaredRouteGroup<unknown>[]): RouteSource<unknown> {
  return { name: 'test', collect: () => groups }
}

/** Initialized, as the compiler's lookups need, and without the process-wide decorated bindings. */
async function container(): Promise<CaffeineIoC> {
  const ioc = new CaffeineIoC({ decorators: false })
  await ioc.init()
  return ioc
}

describe('route selection', () => {
  it('compiles only the groups a selection takes, resolving nothing for the rest', async () => {
    const gold = declared('gold', g => g.label(kTier, 'gold'))
    const free = declared('free', g => g.label(kTier, 'free'))

    const routing = buildRouting([source(gold.group, free.group)], await container())
    const selected = routing.select(labels => labels.get(kTier) === 'gold')

    expect(selected.map(group => group.name)).toEqual(['gold'])
    expect(gold.meta).toHaveBeenCalledTimes(1)
    // What a source resolves for a group — a controller's instance — is never resolved for a group nothing serves.
    expect(free.meta).not.toHaveBeenCalled()
  })

  it('reports the groups no selection took', async () => {
    const gold = declared('gold', g => g.label(kTier, 'gold'))
    const free = declared('free')

    const routing = buildRouting([source(gold.group, free.group)], await container())
    routing.select(labels => labels.has(kTier))

    expect(routing.unselected().map(group => group.name)).toEqual(['free'])
  })

  it('refuses a group two selections both take: two servers would serve it', async () => {
    const routing = buildRouting([source(declared('shared').group)], await container())
    routing.select(() => true)

    expect(() => routing.select(() => true)).toThrow(
      /^Cannot select route group "shared": another server already serves it/,
    )
  })

  it('selects from every source, in the order they declared their groups', async () => {
    const routing = buildRouting(
      [source(declared('a').group, declared('b').group), source(declared('c').group)],
      await container(),
    )

    expect(routing.select(() => true).map(group => group.name)).toEqual(['a', 'b', 'c'])
  })

  it('nests every selected group in the outer group, whose authorization comes first', async () => {
    const reader = declared('reader', g => g.authorize({ roles: ['reader'] }))
    const outer: RouteGroupSpec<unknown> = {
      path: '',
      routes: [],
      accept: [],
      contentType: '',
      authz: { allowAnonymous: false, defaultPolicy: false, policies: [], roleGroups: [['operator']] },
    }

    const [group] = buildRouting([source(reader.group)], await container()).select(() => true, outer)

    // Both are required, the outer one as the outermost level a parent router would be.
    expect(group.routes[0].authorization.options?.roleGroups).toEqual([['operator'], ['reader']])
  })

  it('names the server a group is bound to on the compiled group, and nothing for an unbound one', async () => {
    const bound = declared('bound', bindTo('admin'))
    const own = declared('own')

    const groups = buildRouting([source(bound.group, own.group)], await container()).select(() => true)

    expect(groups.map(group => [group.name, group.boundTo])).toEqual([
      ['bound', 'admin'],
      ['own', undefined],
    ])
  })
})
