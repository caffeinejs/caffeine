import { token } from '@caffeinejs/di'
import { $t, type InferSchema } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { kCacheStatusHeader } from './keys.js'

// The application declares no configuration of its own — `cache.*` belongs to the feature — but a source
// cannot be registered without a schema, so the root names that block and leaves its contents to the
// feature's own slice.
const rootSchema = $t.Object({ cache: $t.Record($t.String(), $t.Unknown(), { default: {} }) })
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
      .cache(() => undefined)
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Cache')
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set status header', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ CACHE__STATUS_HEADER: 'X-Edge-Cache' }), ConfigPriority.ENV))
      .cache(c => c.statusHeader('X-From-Code'))
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
      .cache(c => c.config(x => x.app.cache).statusHeader('X-From-Code'))
      .build()

    await app.ready()

    expect(headerOf(app)).toBe('X-Moved')
  })

  // Activation is the builder call, never the tree.
  it('binds nothing when the application never called cache()', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(new InlineConfigProvider({ cache: { statusHeader: 'X-Ghost' } })))
      .build()

    await app.ready()

    expect(headerOf(app)).toBeUndefined()
  })
})
