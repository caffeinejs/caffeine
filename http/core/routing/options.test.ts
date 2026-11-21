import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { type InferSchema, $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { Args } from '../../decorators/args.js'
import { Controller } from '../../decorators/controller.js'
import { Get } from '../../decorators/verbs.js'
import { node } from '../../platform/node.testkit.js'
import { ErrConfiguration } from '../error/common.js'
import { RouteOptions } from './options.js'
import { $p } from './picker.js'
import { type AnyRouter, Router } from './programmatic/programmatic.js'

const kTestSymbol: unique symbol = Symbol('test.route-option')

declare module './options.js' {
  interface RouteOptions {
    [kTestSymbol]?: number
    testA?: string
    testB?: string
    testObj?: { x?: number; y?: number }
    testMap?: ReadonlyMap<string, number>
  }
}

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

async function serve(...routers: AnyRouter[]) {
  const built = createWebApplication({ adapter: node() }).mount(...routers)
  app = built
  await built.bootstrap()
  return built
}

async function optionsAt(built: { request(path: string): Promise<Response> }, path: string): Promise<unknown> {
  return (await built.request(path)).json()
}

const echo = (ctx: IContext) => ctx.options

describe('route options', () => {
  it('lets a route replace one key of its router, keeping the router’s other keys', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions({ testA: 'group', testB: 'group' })
        .get('/')
        .options({ testA: 'route' })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testA: 'route', testB: 'group' })
  })

  // A route's value is the route's whole word on that key: a cache policy, a CORS policy, never half its group's.
  it('replaces a router’s whole object value with the route’s, rather than merging into it', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions({ testObj: { x: 1 } })
        .get('/')
        .options({ testObj: { y: 2 } })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testObj: { y: 2 } })
  })

  it('merges object values set on the same level, member by member', async () => {
    const built = await serve(
      new Router('/r')
        .get('/')
        .options({ testObj: { x: 1 } }, { testObj: { y: 2 } })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testObj: { x: 1, y: 2 } })
  })

  // A route's constraint keeps its router's version: a Map is a set of named entries, not one value.
  it('merges a Map value with its router’s by key', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions({
          testMap: new Map([
            ['a', 1],
            ['b', 1],
          ]),
        })
        .get('/')
        .options({ testMap: new Map([['b', 2]]) })
        .handler(ctx => Object.fromEntries(ctx.options.testMap ?? [])),
    )

    expect(await optionsAt(built, '/r')).toEqual({ a: 1, b: 2 })
  })

  it('lets a nested router replace its parent’s key', async () => {
    const built = await serve(
      new Router('/outer')
        .routeOptions({ testA: 'outer', testB: 'outer' })
        .mount(new Router('/inner').routeOptions({ testA: 'inner' }).get('/', echo)),
    )

    expect(await optionsAt(built, '/outer/inner')).toEqual({ testA: 'inner', testB: 'outer' })
  })

  it('applies a level’s inputs in the order written, the later one winning', async () => {
    const built = await serve(
      new Router('/r')
        .get('/')
        .options({ testA: '1' }, o => {
          o.testA = '2'
        })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testA: '2' })
  })

  // What a route's configurer could reach, it could change for every sibling sharing the group's object.
  it('hands a route’s configurer the route’s own options alone, not its router’s', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions({ testA: 'group' })
        .get('/')
        .options(o => {
          o.testB = String(o.testA)
        })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testA: 'group', testB: 'undefined' })
  })

  it('hands a configurer the application configuration', async () => {
    const schema = $t.Object({ greeting: $t.String() })
    type AppConfig = InferSchema<typeof schema>

    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ greeting: 'hi' }))
      .build().config
    const built = createWebApplication({ adapter: node(), container: new CaffeineIoC(), config: conf }).mount(
      new Router('/r')
        .configType<AppConfig>()
        .routeOptions((o, { config }) => {
          o.testA = config.greeting
        })
        .get('/', echo),
    )
    app = built
    await built.bootstrap()

    expect(await optionsAt(built, '/r')).toEqual({ testA: 'hi' })
  })

  it('runs a router’s configurer once for all of its routes', async () => {
    const configure = vi.fn((o: Partial<RouteOptions>) => {
      o.testA = 'group'
    })

    const built = await serve(new Router('/r').routeOptions(configure).get('/a', echo).get('/b', echo))

    expect(await optionsAt(built, '/r/b')).toEqual({ testA: 'group' })
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it('runs a router’s configurer once, whatever routers are nested under it', async () => {
    const configure = vi.fn((o: Partial<RouteOptions>) => {
      o.testA = 'outer'
    })

    const built = await serve(
      new Router('/outer')
        .routeOptions(configure)
        .get('/', echo)
        .mount(new Router('/a').get('/', echo), new Router('/b').get('/', echo)),
    )

    expect(await optionsAt(built, '/outer/b')).toEqual({ testA: 'outer' })
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it('names the router when its configurer throws', async () => {
    const thrown = new Error('no webhooks')
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/t')
        .name('throwing')
        .routeOptions(() => {
          throw thrown
        })
        .get('/', echo),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe('Cannot apply the route options of "throwing": no webhooks')
    expect((failure as Error).cause).toBe(thrown)
  })

  // Whatever a configurer throws, the failure still names the route: a value with no `toString` is described instead.
  it('names the router when its configurer throws a value that cannot be printed', async () => {
    const thrown: unknown = Object.create(null)
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/t')
        .name('throwing')
        .routeOptions(() => {
          throw thrown
        })
        .get('/', echo),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot apply the route options of "throwing": it threw a value that cannot be printed',
    )
    expect((failure as Error).cause).toBe(thrown)
  })

  // The thrown error's own footer would otherwise follow this message's first line.
  it('keeps the first line of a thrown multi-line message alone', async () => {
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/t')
        .name('throwing')
        .routeOptions(() => {
          throw new Error('no webhooks\n  - Add a webhooks block')
        })
        .get('/', echo),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect((failure as Error).message.split('\n')[0]).toBe('Cannot apply the route options of "throwing": no webhooks')
    expect((failure as Error).message).not.toContain('Add a webhooks block')
  })

  // A plugin may key its option with a symbol of its own, so no other plugin's key can collide with it.
  it('keeps a symbol-keyed option from the router down to the route', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions({ [kTestSymbol]: 7 })
        .get('/')
        .options({ testA: 'a' })
        .handler(ctx => ({ symbol: ctx.options[kTestSymbol] ?? null, a: ctx.options.testA })),
    )

    expect(await optionsAt(built, '/r')).toEqual({ symbol: 7, a: 'a' })
  })

  it('names the route when a route’s own configurer throws', async () => {
    const thrown = new Error('no webhooks')
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/t')
        .name('group')
        .get('/')
        .name('hook')
        .options(() => {
          throw thrown
        })
        .handler(echo),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot apply the route options of "group.hook": no webhooks',
    )
    expect((failure as Error).cause).toBe(thrown)
  })

  // The router that holds the configurer is the one to look in, not a router nested under it.
  it('names the router that holds a throwing configurer, not one nested under it', async () => {
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/outer')
        .name('outer')
        .routeOptions(() => {
          throw new Error('no webhooks')
        })
        .mount(new Router('/inner').name('inner').get('/', echo)),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect((failure as Error).message.split('\n')[0]).toBe('Cannot apply the route options of "outer": no webhooks')
  })

  // Nothing would wait on it: the options it writes later would never reach the route. The type refuses it too; this is
  // a caller the type does not reach.
  it('refuses to start when a configurer returns a promise', async () => {
    const built = createWebApplication({ adapter: node() }).mount(
      new Router('/p')
        .name('promised')
        .routeOptions((async () => undefined) as never)
        .get('/', echo),
    )
    app = built

    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot apply the route options of "promised": a configurer returned a promise',
    )
  })

  // An object read from configuration may carry an own `__proto__`: it must not reach what a later input reads.
  it('skips a plain object’s own __proto__ key', async () => {
    const built = await serve(
      new Router('/r')
        .get('/')
        .options(JSON.parse('{"__proto__":{"testA":"x"}}') as Partial<RouteOptions>, o => {
          o.testB = o.testA ?? 'none'
        })
        .handler(echo),
    )

    expect(await optionsAt(built, '/r')).toEqual({ testB: 'none' })
  })

  // A configurer can leave an own `__proto__` property, which a copy by assignment would make the prototype.
  it('keeps a configurer’s own __proto__ property from becoming the prototype of the route’s options', async () => {
    const built = await serve(
      new Router('/r')
        .routeOptions(o => {
          Object.defineProperty(o, '__proto__', { value: { testA: 'x' }, enumerable: true, writable: true })
        })
        .get('/', ctx => ({
          plain: Object.getPrototypeOf(ctx.options) === Object.prototype,
          a: ctx.options.testA ?? null,
        })),
    )

    expect(await optionsAt(built, '/r')).toEqual({ plain: true, a: null })
  })

  // One object serves the route, its HEAD twin, every onRoute hook and every request.
  it('freezes a route’s options', async () => {
    const built = await serve(
      new Router('/r')
        .get('/')
        .options({ testA: 'a' })
        .handler(ctx => ({ frozen: Object.isFrozen(ctx.options), a: ctx.options.testA })),
    )

    expect(await optionsAt(built, '/r')).toEqual({ frozen: true, a: 'a' })
  })

  it('reads empty options when no route matched', async () => {
    const seen: unknown[] = []
    const built = createWebApplication({ adapter: node() })
      .hook('onRequest', ctx => void seen.push(ctx.options))
      .mount(new Router('/r').routeOptions({ testA: 'a' }).get('/', echo))
    app = built
    await built.bootstrap()

    expect((await built.request('/nowhere')).status).toBe(404)
    expect(seen).toEqual([{}])
  })
})

// Each controller has a path of its own: `@Controller` registers into a registry every later container snapshots.
describe('@RouteOptions', () => {
  async function serveControllers() {
    const built = createWebApplication({ adapter: node(), container: new CaffeineIoC() })
    app = built
    await built.bootstrap()
    return built
  }

  it('covers every method of a controller, a method’s own key replacing the controller’s', async () => {
    @Controller('/o-class')
    @RouteOptions({ testA: 'class', testB: 'class' })
    class Covered {
      @RouteOptions({ testA: 'method' })
      @Get('/')
      @Args([$p.context()])
      get(ctx: IContext): Readonly<Partial<RouteOptions>> {
        return ctx.options
      }
    }
    void Covered

    const built = await serveControllers()

    expect(await (await built.request('/o-class')).json()).toEqual({ testA: 'method', testB: 'class' })
  })

  it('hands a decorator’s configurer the application configuration', async () => {
    const schema = $t.Object({ greeting: $t.String() })
    type AppConfig = InferSchema<typeof schema>

    @Controller('/o-config')
    @RouteOptions<AppConfig>((o, { config }) => {
      o.testA = config.greeting
    })
    class Configured {
      @RouteOptions<AppConfig>((o, { config }) => {
        o.testB = `${config.greeting}!`
      })
      @Get('/')
      @Args([$p.context()])
      get(ctx: IContext): Readonly<Partial<RouteOptions>> {
        return ctx.options
      }
    }
    void Configured

    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ greeting: 'hi' }))
      .build().config
    const built = createWebApplication({ adapter: node(), container: new CaffeineIoC(), config: conf })
    app = built
    await built.bootstrap()

    expect(await (await built.request('/o-config')).json()).toEqual({ testA: 'hi', testB: 'hi!' })
  })

  // TC39 decorators apply from the one nearest the method outwards, as every route decorator does.
  it('keeps the decorator written first of two stacked on one method', async () => {
    @Controller('/o-stacked')
    class Stacked {
      @RouteOptions({ testA: 'upper' })
      @RouteOptions({ testA: 'lower' })
      @Get('/')
      @Args([$p.context()])
      get(ctx: IContext): Readonly<Partial<RouteOptions>> {
        return ctx.options
      }
    }
    void Stacked

    const built = await serveControllers()

    expect(await (await built.request('/o-stacked')).json()).toEqual({ testA: 'upper' })
  })
})
