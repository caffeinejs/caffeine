import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  FeatureBuilder,
  kFeatureConfigure,
  kFeatureName,
  newConfiguration,
  type Feature,
  type FeatureConfigurer,
} from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig, type LiveConfig } from '@caffeinejs/std/config'
import { $t, type InferSchema } from '@caffeinejs/std/schema'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  Adapter,
  AdapterExtensionFactory,
  AdapterFactory,
  AdapterIn,
  AdapterTypes,
  AnyAdapterTypes,
  ContextPlatform,
} from '../adapter.js'
import { createWebApplication } from '../application.js'
import type { Context } from '../context.js'
import type { FastifyRouterTypes, FastifyTypes } from '../fastify_adapter.js'
import { HTTPFeatureBuilder, kFeatureServer, type HTTPFeature } from '../feature.js'
import { health } from '../health/health.js'
import type { MiddlewareFn } from '../middleware/middleware.js'
import type { ResolvedMiddleware } from '../middleware/pipeline.js'
import { blend } from '../routing/programmatic/blend.js'
import { newRouter } from '../routing/programmatic/new_router.js'
import { Router } from '../routing/programmatic/router.js'
import type { AdapterOf, RoutesOf } from '../routing/programmatic/types.js'

/**
 * The adapter contract, held to its word: an application whose adapter is not Fastify's.
 *
 * Nothing between `.with(...)` and the adapter may assume Fastify, and what one adapter installs must not compile
 * on an application running another. The fake adapter below records what it is handed and installs nothing.
 */

/** A server that is not Fastify. */
interface FakeServer {
  readonly fake: true
}

/** What the fake adapter installs: an object, so no Fastify plugin, being a function, passes for one. */
interface FakeUnit {
  readonly unit: string
}

interface FakePlatform extends ContextPlatform {
  readonly name: 'fake'
  readonly raw: string
}

interface FakeTypes extends AdapterTypes {
  instance: FakeServer
  request: { readonly fake: true }
  extension: FakeUnit
  hook: 'before' | 'after'
  raw: string
  cookieOptions: { readonly path?: string }
  asyncCookies: false
  platform: FakePlatform
}

/** A server with nothing to install and no lifecycle to hook into. */
interface BareTypes extends FakeTypes {
  extension: never
  hook: never
}

/** Records what the application hands it. All this file needs is the contract, so it serves nothing. */
class RecordingAdapter<T extends AdapterTypes> implements Adapter<T> {
  input: AdapterIn<T> | undefined
  middlewares: ResolvedMiddleware[] = []

  constructor(readonly instance: T['instance']) {}

  get address(): undefined {
    return undefined
  }

  async setup(input: AdapterIn<T>): Promise<void> {
    this.input = input
    this.middlewares = input.middlewares.resolve(input.context)
  }

  run(): Promise<void> {
    return Promise.resolve()
  }

  fetch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 501 }))
  }

  teardown(): Promise<void> {
    return Promise.resolve()
  }
}

function recording<T extends AdapterTypes>(adapter: RecordingAdapter<T>): AdapterFactory<T> {
  return () => adapter
}

function onFake(adapter = new RecordingAdapter<FakeTypes>({ fake: true })) {
  return createWebApplication(recording(adapter), { container: new CaffeineIoC({ decorators: false }) })
}

function onBare() {
  return createWebApplication(recording(new RecordingAdapter<BareTypes>({ fake: true })), {
    container: new CaffeineIoC({ decorators: false }),
  })
}

/** A feature written against the fake server. */
function fakeFeature(name: string): HTTPFeature<unknown, FakeServer> {
  return {
    [kFeatureName]: name,
    [kFeatureConfigure](): void {
      // Nothing to bind.
    },
    [kFeatureServer]: (): void => {
      // The recording adapter never runs a hook.
    },
  }
}

const noop: FastifyPluginAsync = async () => undefined

describe('an application on an adapter that is not Fastify', () => {
  // The contract's whole claim at run time: the adapter gets the root list in the order it was written, with error
  // handling first and the cookie parsing behind it — the two the application registers itself, before anything
  // `.with(...)` adds — and resolves the middleware pipeline with no server in sight.
  it('hands the adapter its extensions in order and a pipeline it resolves alone', async () => {
    const adapter = new RecordingAdapter<FakeTypes>({ fake: true })
    const unit =
      (name: string): AdapterExtensionFactory<FakeUnit> =>
      () => ({ unit: name })

    const app = onFake(adapter)
      .with(unit('first'))
      .with(fakeFeature('second'))
      .with(unit('third'))
      .use((_ctx, next) => next(), { hook: 'after' })

    await app.ready()

    const root = (adapter.input?.extensions.root() ?? []).map(entry =>
      entry.kind === 'feature' ? `feature:${entry.name}` : `extension:${entry.extension.unit}`,
    )

    expect(root).toEqual([
      'feature:error-handling',
      'feature:cookie',
      'extension:first',
      'feature:second',
      'extension:third',
    ])
    expect(adapter.middlewares.map(middleware => middleware.hook)).toEqual(['after'])

    await app.close()
  })

  // The application resolves and normalizes the base path whatever the server: taking it off a request is all
  // an adapter is left to do, so every adapter reads the same value.
  it.each([
    ['/api/', '/api'],
    ['/', undefined],
    [undefined, undefined],
  ])('hands the adapter the base path %s as %s', async (given, expected) => {
    const adapter = new RecordingAdapter<FakeTypes>({ fake: true })
    const app = onFake(adapter)
    if (given !== undefined) {
      app.basePath(given)
    }

    await app.ready()

    expect(adapter.input).toBeDefined()
    expect(adapter.input!.basePath).toBe(expected)

    await app.close()
  })
})

describe('adapter types', () => {
  it('registers the Fastify adapter through the registry', () => {
    expectTypeOf<AnyAdapterTypes>().toEqualTypeOf<FastifyTypes>()
  })

  it('refuses what another adapter installs', () => {
    // @ts-expect-error a feature written for another server
    createWebApplication().with(fakeFeature('elsewhere'))

    // @ts-expect-error a Fastify plugin factory on an application that does not run Fastify
    onFake().with(health())

    // @ts-expect-error a Fastify plugin on an application that does not run Fastify
    onFake().with(() => noop)

    onFake().with(() => ({ unit: 'fake' }))
    onFake().with(fakeFeature('fits'))

    // @ts-expect-error an adapter that installs nothing takes no factory
    onBare().with(() => ({ unit: 'nothing' }))
  })

  it('takes the hook names the adapter declares, and no others', () => {
    const fn: MiddlewareFn = (_ctx, next) => next()

    createWebApplication().use(fn, { hook: 'preHandler' })
    onFake().use(fn, { hook: 'before' })

    // @ts-expect-error a Fastify hook on an adapter that does not have it
    onFake().use(fn, { hook: 'preHandler' })

    // @ts-expect-error an adapter with no hooks takes none
    onBare().use(fn, { hook: 'before' })
  })

  it('lets only a router bound to an adapter take a plugin', () => {
    // @ts-expect-error a router bound to no adapter has nothing to install
    new Router('/unbound').plugin(() => noop)

    const bound = newRouter('/x')
      .plugin(() => noop)
      .get('/y', () => 1)

    expectTypeOf<RoutesOf<typeof bound>['path']>().toEqualTypeOf<'/x/y'>()
  })

  it('keeps a router bound through everything that re-types it', () => {
    class Clock {}

    const base = newRouter('/keep')
    const vars = base.vars<{ tenant: string }>()
    const configured = vars.configType<{ page: number }>()
    const injected = configured.inject({ clock: Clock })
    const routed = injected.get('/a', () => 1)
    const mounted = routed.mount(new Router('/child').get('/', () => 2))
    const blended = blend(mounted, newRouter('/other'))

    expectTypeOf<AdapterOf<typeof base>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof vars>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof configured>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof injected>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof routed>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof mounted>>().toEqualTypeOf<FastifyRouterTypes>()
    expectTypeOf<AdapterOf<typeof blended>>().toEqualTypeOf<FastifyRouterTypes>()
  })

  it('mounts a router bound to no adapter anywhere, and a bound one only where it belongs', () => {
    const unbound = new Router('/free').get('/', () => 1)
    const bound = newRouter('/fastify').get('/', () => 1)

    createWebApplication().mount(unbound, bound)
    createWebApplication().mount(bound)
    onFake().mount(unbound)
    newRouter('/parent').mount(unbound)

    // @ts-expect-error a Fastify-bound router on an application that does not run Fastify
    onFake().mount(bound)
  })

  it('types ctx.platform wherever a context is read', () => {
    const fromContext = (ctx: Context) => ctx.platform.reply
    const fromUnbound = new Router('/u').get('/', ctx => ctx.platform.reply.statusCode)
    const fromBound = newRouter('/b').get('/', ctx => ctx.platform.reply.statusCode)

    expectTypeOf<ReturnType<typeof fromContext>>().toEqualTypeOf<FastifyReply>()
    expectTypeOf<RoutesOf<typeof fromUnbound>['output']>().toEqualTypeOf<number>()
    expectTypeOf<RoutesOf<typeof fromBound>['output']>().toEqualTypeOf<number>()
  })

  // What a second registered adapter does to code written without knowing its adapter. Augmenting the registry
  // here would reach every file this check project compiles, so the union it would produce is spelled out instead.
  it('makes a reader narrow on the platform name once a second adapter is registered', () => {
    type Both = FastifyTypes | FakeTypes

    const read = (ctx: Context<Record<never, never>, Record<never, never>, Both>) => {
      // @ts-expect-error the fake platform has no reply
      void ctx.platform.reply

      return ctx.platform.name === 'fastify' ? ctx.platform.reply : undefined
    }

    expectTypeOf<ReturnType<typeof read>>().toEqualTypeOf<FastifyReply | undefined>()

    const accepts = (factory: AdapterExtensionFactory<Both['extension']>) => factory
    accepts(() => ({ unit: 'fake' }))
    accepts(() => noop)
  })
})

describe('configure callback typing', () => {
  const schema = $t.Object({ name: $t.String({ default: 'app' }) })
  type AppConfig = InferSchema<typeof schema>
  const kConfig = token<InferConfig<typeof schema>>(Symbol('adapter-agnostic.config'))

  class PlainBuilder<C = unknown> extends FeatureBuilder<C> {
    readonly [kFeatureName] = 'plain-probe'
  }

  class ServerSideBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
    readonly [kFeatureName] = 'server-side-probe'
  }

  function plain<C = unknown>(configure?: FeatureConfigurer<PlainBuilder<C>, C>): Feature<C> {
    return new PlainBuilder<C>(configure as never)
  }

  function serverSide<C = unknown>(configure?: FeatureConfigurer<ServerSideBuilder<C>, C>): HTTPFeature<C> {
    return new ServerSideBuilder<C>(configure as never)
  }

  // `.with(...)` is overloaded, and only the overload TypeScript tries first contextually types a callback. Each
  // call shape must still reach the application's configuration type rather than fall back to `unknown` — a
  // feature through its `FeatureConfigureKit`, a plugin factory's builder through its `HTTPSetupContext`.
  it('types the callback against the application configuration, whichever overload takes it', () => {
    const conf = newConfiguration(schema, kConfig).source(new InlineConfigSource({})).build()

    const app = createWebApplication({ config: conf })
      .with(plain((_b, kit) => expectTypeOf(kit.config).toEqualTypeOf<LiveConfig<AppConfig>>()))
      .with(serverSide((_b, kit) => expectTypeOf(kit.config).toEqualTypeOf<LiveConfig<AppConfig>>()))
      .with(health((_h, context) => expectTypeOf(context.config).toEqualTypeOf<LiveConfig<AppConfig>>()))

    expect(app).toBeDefined()
  })
})
