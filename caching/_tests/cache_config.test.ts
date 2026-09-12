import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  EnvConfigProvider,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { cacheConfigSchema, caching, kCacheStatusHeader } from '../index.js'

// The application owns the schema: it declares where the cache block lives — by importing the feature's own
// schema — and the configure callback reads that node.
const rootSchema = $t.Object({ cache: cacheConfigSchema })
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

const headerOf = (app: WebApplication): string | undefined => app.container.getOptional<string>(kCacheStatusHeader)

describe('cache configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('defaults the status header when nothing configures it', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(caching())
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Cache')
  })

  // The semantic the mechanism rests on: a fluent method is the last word. Configuration is not a higher
  // band that quietly outranks it — it reaches a feature only where the callback wired it, and here the
  // callback did not.
  it('keeps a builder-set status header even when the environment names one', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ CACHE__STATUS_HEADER: 'X-Edge-Cache' }), ConfigPriority.ENV))
      .extend(caching(cache => cache.statusHeader('X-From-Code')))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-From-Code')
  })

  // The other half of the same rule: wire it, and the environment is what the feature runs on.
  it('reads the status header from the environment when the callback wires it', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ CACHE__STATUS_HEADER: 'X-Edge-Cache' }), ConfigPriority.ENV))
      .extend(caching((cache, c) => cache.withConfig(c.cache)))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Edge-Cache')
  })

  // Where the block lives is the application's choice, and the callback is what names it — so relocating it
  // costs one selector and nothing else.
  it('reads the status header from wherever the application put the block', async () => {
    const schema = $t.Object({
      app: $t.Object({ cache: $t.Object({ statusHeader: $t.String({ default: 'X-Cache' }) }) }),
    })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(schema, kConfig, c =>
        c.source(
          new InlineConfigProvider({
            app: { cache: { statusHeader: 'X-Moved' } },
          }),
        ),
      )
      .extend(caching((cache, c) => cache.withConfig(c.app.cache)))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Moved')
  })

  // Caching is fluent-wins: naming the header in code beats a wired environment value.
  it('keeps a builder-set status header over a wired environment value', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ CACHE__STATUS_HEADER: 'X-Edge-Cache' }), ConfigPriority.ENV))
      .extend(caching((cache, c) => cache.statusHeader('X-From-Code').withConfig(c.cache)))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-From-Code')
  })

  // The header name is snapshotted at `ready()`. A refresh updates the tree; the binding and the hooks do not
  // follow it — that is intentional, not a missed liveFold.
  it('snapshots the status header at ready, so a refresh does not rename it', async () => {
    let data: InferSchema<typeof rootSchema> = { cache: { statusHeader: 'X-Before' } }
    const reloadable: ConfigProvider = {
      id: 'test',
      reloadable: true,
      load: ctx => new InlineConfigProvider(data).load(ctx),
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(reloadable))
      .extend(caching((cache, c) => cache.withConfig(c.cache)))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Before')

    data = { cache: { statusHeader: 'X-After' } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(headerOf(app)).toBe('X-Before')
  })

  // Activation is installing the feature, never the tree.
  it('binds nothing when the caching feature is not installed', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(new InlineConfigProvider({ cache: { statusHeader: 'X-Ghost' } })))
      .build()

    await app.ready()

    expect(headerOf(app)).toBeUndefined()
  })
})
