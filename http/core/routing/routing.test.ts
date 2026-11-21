import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'

import { bindTo } from '../../decorators/bind_to.js'
import type { HTTPSetupContext } from '../../plugin.js'
import { RouteBuilder, RouteGroupBuilder } from './builder.js'
import { buildRouting, type DeclaredRouteGroup, type RouteSource } from './routing.js'

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
async function context(): Promise<HTTPSetupContext> {
  const ioc = new CaffeineIoC({ decorators: false })
  await ioc.init()
  return { container: ioc } as unknown as HTTPSetupContext
}

describe('route selection', () => {
  it('compiles only the groups a selection takes, resolving nothing for the rest', async () => {
    const gold = declared('gold', g => g.label(kTier, 'gold'))
    const free = declared('free', g => g.label(kTier, 'free'))

    const routing = buildRouting([source(gold.group, free.group)], await context())
    const selected = routing.select(labels => labels.get(kTier) === 'gold')

    expect(selected.map(group => group.name)).toEqual(['gold'])
    expect(gold.meta).toHaveBeenCalledTimes(1)
    // What a source resolves for a group — a controller's instance — is never resolved for a group nothing serves.
    expect(free.meta).not.toHaveBeenCalled()
  })

  it('reports the groups no selection took', async () => {
    const gold = declared('gold', g => g.label(kTier, 'gold'))
    const free = declared('free')

    const routing = buildRouting([source(gold.group, free.group)], await context())
    routing.select(labels => labels.has(kTier))

    expect(routing.unselected().map(group => group.name)).toEqual(['free'])
  })

  it('refuses a group two selections both take: two servers would serve it', async () => {
    const routing = buildRouting([source(declared('shared').group)], await context())
    routing.select(() => true)

    expect(() => routing.select(() => true)).toThrow(
      /^Cannot select route group "shared": another server already serves it/,
    )
  })

  it('selects from every source, in the order they declared their groups', async () => {
    const routing = buildRouting(
      [source(declared('a').group, declared('b').group), source(declared('c').group)],
      await context(),
    )

    expect(routing.select(() => true).map(group => group.name)).toEqual(['a', 'b', 'c'])
  })

  it('names the server a group is bound to on the compiled group, and nothing for an unbound one', async () => {
    const bound = declared('bound', bindTo('admin'))
    const own = declared('own')

    const groups = buildRouting([source(bound.group, own.group)], await context()).select(() => true)

    expect(groups.map(group => [group.name, group.boundTo])).toEqual([
      ['bound', 'admin'],
      ['own', undefined],
    ])
  })
})

describe('route hooks', () => {
  // The group's hooks wrap every route the same way; a route's own run inside them, last.
  it("runs a route's own hooks after its group's, each handed the context", async () => {
    const order: string[] = []
    const group = new RouteGroupBuilder()
      .path('/pets')
      .hook('onRequest', () => void order.push('group'))
      .routes([
        new RouteBuilder()
          .method('GET')
          .path('/')
          .handle(() => ({}))
          .hook('onRequest', ctx => void order.push(`route:${String(ctx)}`)),
      ])
    const declaredGroup: DeclaredRouteGroup<unknown> = {
      name: 'pets',
      spec: group.toRouteGroup(),
      meta: () => ({ name: 'pets' }),
    }

    const [compiled] = buildRouting([source(declaredGroup)], await context()).select(() => true)
    const hooks = compiled.routes[0].hooks!.onRequest
    for (const hook of hooks) {
      await hook('req', 'ctx' as never)
    }

    expect(order).toEqual(['group', 'route:ctx'])
  })
})
