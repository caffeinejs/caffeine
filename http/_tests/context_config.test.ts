import { CaffeineIoC, token } from '@caffeinejs/di'
import { type InferSchema, type Service, type ServiceBeforeBootstrapIn, $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  InlineConfigProvider,
  defineFeatureConfig,
  featureConfigKey,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  type MiddlewareFn,
  Router,
  createWebApplication,
  fastifyAdapterFactory,
  kServerContribution,
} from '../index.js'

const schema = $t.Object({
  catalog: $t.Object({ pageSize: $t.Number() }),
})

type AppConfig = InferSchema<typeof schema>

const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))

/** A source the test can re-point, so a refresh actually re-resolves rather than being skipped. */
function reloadable(read: () => AppConfig): ConfigProvider {
  return {
    id: 'test',
    reloadable: true,
    load: ctx => new InlineConfigProvider(read()).load(ctx),
  }
}

describe('ctx.config', () => {
  it('hands the handler what the application configured', async () => {
    const routes = new Router('/catalog')
      .configType<AppConfig>()
      .get('/page-size', ctx => ({ pageSize: ctx.config.catalog.pageSize }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ catalog: { pageSize: 25 } })))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog/page-size')).json()).toEqual({ pageSize: 25 })

    await app.close()
  })

  it('keeps one snapshot for the whole request, across a refresh that lands mid-request', async () => {
    let current: AppConfig = { catalog: { pageSize: 25 } }
    const seen: unknown[] = []

    // Reads the config, then re-points the source and refreshes before the handler runs. Whatever the handler
    // sees afterwards is what "the config does not move under a request" means.
    const churn: MiddlewareFn<Record<never, never>, AppConfig> = async (ctx, next) => {
      seen.push(ctx.config)
      current = { catalog: { pageSize: 100 } }
      await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
      return next()
    }

    const routes = new Router('/catalog').configType<AppConfig>().get('/page-size', ctx => {
      seen.push(ctx.config)
      return { pageSize: ctx.config.catalog.pageSize }
    })

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(schema, kConfig, c => c.source(reloadable(() => current)))
      .build()
      .mount(routes)

    app.use(churn, 'onRequest')

    await app.ready()

    expect(await (await app.fetch('/catalog/page-size')).json()).toEqual({ pageSize: 25 })
    // The handler was served the very object the middleware took, not a second snapshot of the same values.
    expect(seen[0]).toBe(seen[1])

    // The refresh was real: the next request is configured by what it resolved.
    expect(app.container.get(kConfig).catalog.pageSize).toBe(100)
    expect(await (await app.fetch('/catalog/page-size')).json()).toEqual({ pageSize: 100 })

    await app.close()
  })

  it('serves an application that declared no configuration at all', async () => {
    const routes = new Router('/plain').get('/', ctx => ({ keys: Object.keys(ctx.config) }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .build()
      .mount(routes)

    await app.ready()

    // No `.config()` call, so there is no application config key to resolve — and the context still reads,
    // because it is served by the configuration the framework's own features resolved for themselves. `health`
    // is here because every slice's resolved values are placed into the root tree, not only the ones that
    // wrote framework defaults into it.
    expect(await (await app.fetch('/plain')).json()).toEqual({ keys: ['caffeine', 'server', 'health'] })

    await app.close()
  })

  it('refuses a write, because the tree it hands back is frozen', async () => {
    const routes = new Router('/catalog').configType<AppConfig>().get('/write', ctx => {
      try {
        // @ts-expect-error — the projection is deep-readonly; this is the run-time half of the same rule.
        ctx.config.catalog.pageSize = 1
        return { threw: false }
      } catch {
        return { threw: true }
      }
    })

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ catalog: { pageSize: 25 } })))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog/write')).json()).toEqual({ threw: true })

    await app.close()
  })
})

describe('ctx.config typing', () => {
  it('types the context from what the router declared', () => {
    new Router('/catalog').configType<AppConfig>().get('/', ctx => {
      expectTypeOf(ctx.config.catalog.pageSize).toEqualTypeOf<number>()
      return null
    })
  })

  it('carries nothing a router left undeclared', () => {
    new Router('/catalog').get('/', ctx => {
      // @ts-expect-error — a router that named no config type reads nothing off it.
      return ctx.config.catalog
    })
  })

  it('types an $i.value selector from the router config, without the call naming it again', () => {
    new Router('/catalog')
      .configType<AppConfig>()
      .inject($i => ({
        pageSize: $i.value(c => {
          expectTypeOf(c).toEqualTypeOf<AppConfig>()
          return c.catalog.pageSize
        }),
      }))
      .get('/', (_ctx, deps) => {
        expectTypeOf(deps.pageSize).toEqualTypeOf<number>()
        return null
      })
  })

  it('still lets a call name a type over the router one', () => {
    new Router('/catalog')
      .configType<AppConfig>()
      .inject($i => ({
        other: $i.value<{ a: { b: string } }, string>(c => {
          expectTypeOf(c).toEqualTypeOf<{ a: { b: string } }>()
          return c.a.b
        }),
      }))
      .get('/', (_ctx, deps) => {
        expectTypeOf(deps.other).toEqualTypeOf<string>()
        return null
      })
  })
})

/**
 * What a package with no knowledge of the application reads its own settings with.
 *
 * `.configType<C>()` names the *application's* shape, which a package cannot know, and the namespace is
 * relocatable, so neither is an address a package can use. The key is, and the context is where it is answered.
 */
describe('ctx.config(featureKey)', () => {
  interface WidgetConfig {
    size: number
  }

  const widgetSchema = $t.Object({ size: $t.Number({ default: 1 }) })
  const kWidget = featureConfigKey<WidgetConfig>('widget')

  /** A feature registering its slice under a key, the way a first-party package's builder does. */
  class WidgetService implements Service {
    constructor(private readonly at?: (c: never) => unknown) {}

    get name(): string {
      return 'widget'
    }

    beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
      defineFeatureConfig<WidgetConfig>(kit.config, {
        namespace: ['widget'],
        selector: this.at,
        key: kWidget,
        schema: widgetSchema,
        values: { size: 7 },
      })
    }

    bootstrap(): Promise<void> {
      return Promise.resolve()
    }
  }

  it('hands a package its own configuration, whatever the application declared', async () => {
    // Note the router declares no config type at all: reading by key does not depend on one.
    const routes = new Router('/widget').get('/', ctx => ({ size: ctx.config(kWidget)?.size }))

    const builder = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
    builder.addService(new WidgetService())
    const app = builder.build().mount(routes)

    await app.ready()

    expect(await (await app.fetch('/widget')).json()).toEqual({ size: 7 })

    await app.close()
  })

  it('finds the slice after the feature relocated it', async () => {
    const routes = new Router('/widget').get('/', ctx => ({ size: ctx.config(kWidget)?.size }))

    const builder = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
    builder.addService(new WidgetService(c => (c as { app: { widget: unknown } }).app.widget))
    const app = builder.build().mount(routes)

    await app.ready()

    expect(await (await app.fetch('/widget')).json()).toEqual({ size: 7 })

    await app.close()
  })

  // A feature the application never installed is absent, not an error — which is what lets a package ship a
  // fallback rather than requiring the feature to be installed before its helpers can be called.
  it('reads undefined when nothing registered the key', async () => {
    const routes = new Router('/widget').get('/', ctx => ({ found: ctx.config(kWidget) !== undefined }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/widget')).json()).toEqual({ found: false })

    await app.close()
  })
})

/**
 * The case the whole mechanism exists for.
 *
 * An application that declares its own configuration used to *lose* the framework's from the same tree:
 * validation drops every key the schema does not name, so `ctx.config.server` and `$i.value(c => c.server...)`
 * both went missing in exactly the applications that bothered to describe their settings.
 */
describe('ctx.config with an application schema', () => {
  const ownSchema = $t.Object({ catalog: $t.Object({ pageSize: $t.Number() }) })

  type FullConfig = InferSchema<typeof ownSchema> & { server: { host: string; port: number } }

  // The key names the whole tree; the schema declares only what the application owns. The framework's half is
  // in the resolved tree either way, so naming it here is accurate rather than a lie.
  const kFull = token<ConfigHandle<FullConfig>>(Symbol('app.full'))

  it('still reads a framework namespace the schema never declared', async () => {
    const routes = new Router('/catalog')
      .configType<FullConfig>()
      .get('/', ctx => ({ pageSize: ctx.config.catalog.pageSize, host: ctx.config.server.host }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(ownSchema, kFull, c => c.source(new InlineConfigProvider({ catalog: { pageSize: 25 } })))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog')).json()).toEqual({ pageSize: 25, host: '0.0.0.0' })

    await app.close()
  })

  // The values provider is bound to the same handle, so the loss was never confined to `ctx.config`.
  it('resolves an $i.value selector into a framework namespace', async () => {
    const routes = new Router('/catalog')
      .configType<FullConfig>()
      .inject($i => ({ host: $i.value(c => c.server.host) }))
      .get('/', (_ctx, deps) => ({ host: deps.host }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(ownSchema, kFull, c => c.source(new InlineConfigProvider({ catalog: { pageSize: 25 } })))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog')).json()).toEqual({ host: '0.0.0.0' })

    await app.close()
  })

  it('lets the application default a builtin feature from its own schema', async () => {
    const withServer = $t.Object({
      server: $t.Object(
        { port: $t.Number({ default: 4321 }), host: $t.String({ default: '0.0.0.0' }) },
        { default: {} },
      ),
    })
    const kServer = token<ConfigHandle<InferSchema<typeof withServer>>>(Symbol('app.server'))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
      .config(withServer, kServer)
      .build()

    await app.ready()

    // Read through the server's own contribution, not the root handle: the root would show 4321 either way,
    // because the application schema declares it. What has to be true is that the value reached the *feature*,
    // whose framework default is 0 — an OS-assigned port.
    expect(app.contributions.get(kServerContribution).port).toBe(4321)

    await app.close()
  })
})
