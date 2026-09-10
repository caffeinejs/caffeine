import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { cacheConfigSchema, caching, kCacheStatusHeader } from '../index.js'

// The application owns the schema: it declares where the cache block lives — by importing the feature's own
// schema — and `.extend(caching(), c => c.config(...))` points the feature at it.
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

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set status header', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ CACHE__STATUS_HEADER: 'X-Edge-Cache' }), ConfigPriority.ENV))
      .extend(caching(), c => c.config(c => c.cache).statusHeader('X-From-Code'))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Edge-Cache')
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
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
      .extend(caching(), c => c.config(x => x.app.cache).statusHeader('X-From-Code'))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Moved')
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
