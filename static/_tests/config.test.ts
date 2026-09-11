import { fileURLToPath } from 'node:url'

import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import {
  ConfigPriority,
  Configuration,
  EnvConfigProvider,
  InlineConfigProvider,
  type ConfigHandle,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { kStaticOptions, staticFiles } from '../index.js'
import type { StaticMount } from '../static.js'

// The application owns the schema: it declares where the static block lives and `s.config(c => c.static)`
// points the feature at it. Declared field by field rather than by importing `staticConfigSchema`: every
// field of `StaticConfigSlice` is optional, so a block naming only what these tests configure satisfies the
// feature, and that schema is small enough for TypeScript to infer a config type from.
const rootSchema = $t.Object({
  static: $t.Object(
    {
      mounts: $t.Optional($t.Array($t.Object({ root: $t.String(), prefix: $t.Optional($t.String()) }))),
      // `root` is optional here because `.spa(root)` supplies it: configuration retunes a SPA the
      // application switched on, it never creates one.
      spa: $t.Optional(
        $t.Object({
          root: $t.Optional($t.String()),
          index: $t.Optional($t.String()),
          navigationOnly: $t.Optional($t.Boolean()),
        }),
      ),
    },
    { default: {} },
  ),
})
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const dist = fileURLToPath(new URL('./_testdata/spa', import.meta.url))
const fixtures = fileURLToPath(new URL('./_testdata/fixtures2', import.meta.url))

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

describe('static configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // What the feature actually serves, read the way any code outside the builder reads it: off the binding the
  // feature made for it.
  const resolved = (built: WebApplication) => built.container.get(kStaticOptions)
  const mountsOf = (built: WebApplication): readonly StaticMount[] => resolved(built).mounts

  it('reads mounts from the configuration tree with no serve() call at all', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            static: { mounts: [{ root: fixtures, prefix: '/from-config/' }] },
          }),
        ),
      )
      .extend(staticFiles((s, c) => s.withConfig(c.static)))
      .build()

    await app.ready()

    expect(mountsOf(app)).toEqual([{ root: fixtures, prefix: '/from-config/' }])
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set mount root', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ STATIC__MOUNTS__0__ROOT: fixtures }), ConfigPriority.ENV))
      .extend(staticFiles((s, c) => s.withConfig(c.static).serve(dist, { prefix: '/assets/' })))
      .build()

    await app.ready()

    // The array rule: a higher band replaces the whole list rather than patching an element, so the prefix
    // the builder set is gone with it. That is what makes a mount removable from a config file at all.
    expect(mountsOf(app)).toEqual([{ root: fixtures }])
  })

  it('keeps a third-party option the schema never declared', async () => {
    const setHeaders = (): void => undefined

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticFiles(s => s.serve(fixtures, { prefix: '/assets/', setHeaders })))
      .build()

    await app.ready()

    // `Value.Clean` strips whatever a schema names, so the mount is carried as an unvalidated bag on purpose.
    expect(mountsOf(app)[0].setHeaders).toBe(setHeaders)
    expect(mountsOf(app)[0].prefix).toBe('/assets/')
  })

  it('lets configuration retune a SPA the application switched on', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            static: { spa: { index: 'index.html', navigationOnly: false } },
          }),
        ),
      )
      .extend(staticFiles((s, c) => s.withConfig(c.static).spa(dist)))
      .build()

    await app.ready()

    const settings = resolved(app).spa!
    expect(settings.root).toBe(dist)
    expect(settings.navigationOnly).toBe(false)
  })

  // Activation is the builder call, never the tree.
  it('does not switch a SPA on from configuration alone', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            static: { spa: { root: dist } },
          }),
        ),
      )
      .extend(staticFiles((s, c) => s.withConfig(c.static).serve(fixtures)))
      .build()

    await app.ready()

    expect(resolved(app).spa).toBeUndefined()
  })

  it('reads the mounts from wherever the application put the block', async () => {
    const schema = $t.Object({
      app: $t.Object(
        {
          assets: $t.Object({ mounts: $t.Optional($t.Array($t.Record($t.String(), $t.Unknown()))) }, { default: {} }),
        },
        { default: {} },
      ),
    })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ app: { assets: {} } })))
      .extend(staticFiles((s, c) => s.withConfig(c.app.assets).serve(fixtures, { prefix: '/moved/' })))
      .build()

    await app.ready()

    expect(mountsOf(app)).toEqual([{ root: fixtures, prefix: '/moved/' }])
  })
})
