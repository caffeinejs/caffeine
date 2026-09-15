import { CaffeineIoC, token } from '@caffeinejs/di'
import { newConfiguration, type InferSchema, $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  Configuration,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { type MiddlewareFn, Router, createWebApplication, fastifyAdapterFactory, kServerOptions } from '../index.js'

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

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigProvider({ catalog: { pageSize: 25 } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
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

    const conf = newConfiguration(schema, kConfig)
      .source(reloadable(() => current))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
      .build()
      .mount(routes)

    app.use(churn, { hook: 'onRequest' })

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

    // No `config` constructor option, so there is no application config key to resolve — and the context still reads.
    // Only `caffeine` is there: it is the framework's own block, while the server and health features were
    // pointed nowhere and therefore contribute no field to the tree.
    expect(await (await app.fetch('/plain')).json()).toEqual({ keys: ['caffeine'] })

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

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigProvider({ catalog: { pageSize: 25 } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
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
 * The application owns the schema, so a feature's settings are in `ctx.config` when the application declared
 * them there and pointed the feature at them — never because the feature was installed.
 *
 * The two halves have to agree: what the application reads through the tree and what actually reached the
 * feature. Declaring `server.port` and reading 4321 back from the handle proves nothing on its own; the server
 * has to be listening on it.
 */
describe('ctx.config with an application schema', () => {
  const ownSchema = $t.Object({
    catalog: $t.Object({ pageSize: $t.Number() }),
    server: $t.Object({ port: $t.Number({ default: 0 }), host: $t.String({ default: '0.0.0.0' }) }, { default: {} }),
  })

  type FullConfig = InferSchema<typeof ownSchema>

  const kFull = token<ConfigHandle<FullConfig>>(Symbol('app.full'))

  it('reads a feature block the application declared and pointed the feature at', async () => {
    const routes = new Router('/catalog')
      .configType<FullConfig>()
      .get('/', ctx => ({ pageSize: ctx.config.catalog.pageSize, host: ctx.config.server.host }))

    const conf = newConfiguration(ownSchema, kFull)
      .source(new InlineConfigProvider({ catalog: { pageSize: 25 } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
      .server((s, c) => s.withConfig(c.server))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog')).json()).toEqual({ pageSize: 25, host: '0.0.0.0' })

    await app.close()
  })

  // The values provider is bound to the same handle, so it sees the same tree `ctx.config` does.
  it('resolves an $i.value selector into a declared feature block', async () => {
    const routes = new Router('/catalog')
      .configType<FullConfig>()
      .inject($i => ({ host: $i.value(c => c.server.host) }))
      .get('/', (_ctx, deps) => ({ host: deps.host }))

    const conf = newConfiguration(ownSchema, kFull)
      .source(new InlineConfigProvider({ catalog: { pageSize: 25 } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
      .server((s, c) => s.withConfig(c.server))
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/catalog')).json()).toEqual({ host: '0.0.0.0' })

    await app.close()
  })

  // A feature the application never placed is absent from the tree entirely, whatever a source says about a
  // name that looks like it.
  it('leaves out a feature block the application declared nothing for', async () => {
    const routes = new Router('/plain').configType<FullConfig>().get('/', ctx => ({ keys: Object.keys(ctx.config) }))

    const conf = newConfiguration($t.Object({ catalog: $t.Object({ pageSize: $t.Number() }) }), kFull)
      .source(new InlineConfigProvider({ catalog: { pageSize: 25 }, server: { host: '127.0.0.1' } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
      .build()
      .mount(routes)

    await app.ready()

    expect(await (await app.fetch('/plain')).json()).toEqual({ keys: ['catalog'] })
    // And the server did not take it either — it was pointed nowhere, so its own default stands.
    expect(app.container.get(kServerOptions).host).toBe('0.0.0.0')

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

    const conf = newConfiguration(withServer, kServer).build()
    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC(), config: conf })
      .server((s, c) => s.withConfig(c.server))
      .build()

    await app.ready()

    // Read through the server's own key, not the root handle: the root would show 4321 either way,
    // because the application schema declares it. What has to be true is that the value reached the *feature*,
    // whose framework default is 0 — an OS-assigned port.
    expect(app.container.get(kServerOptions).port).toBe(4321)

    await app.close()
  })
})
