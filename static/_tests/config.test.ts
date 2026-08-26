import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider } from '@caffeinejs/std/config'
import { kSPASettings, kStaticMounts, staticPlugin } from '../index.js'
import type { SPASettings } from '../spa.js'
import type { StaticMount } from '../static.js'

const dist = fileURLToPath(new URL('./_testdata/spa', import.meta.url))
const fixtures = fileURLToPath(new URL('./_testdata/fixtures2', import.meta.url))

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

describe('static configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const mountsOf = (built: WebApplication): StaticMount[] =>
    built.container.get(kStaticMounts) as StaticMount[]

  it('reads mounts from the configuration tree with no serve() call at all', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .config(c => c.source(new InlineConfigProvider({
        static: { mounts: [{ root: fixtures, prefix: '/from-config/' }] },
      })))
      .static(() => undefined)
      .build()

    await app.ready()

    expect(mountsOf(app)).toEqual([{ root: fixtures, prefix: '/from-config/' }])
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set mount root', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .config(c => c.source(env({ STATIC__MOUNTS__0__ROOT: fixtures }), ConfigPriority.ENV))
      .static(s => s.serve(dist, { prefix: '/assets/' }))
      .build()

    await app.ready()

    // The array rule: a higher band replaces the whole list rather than patching an element, so the prefix
    // the builder set is gone with it. That is what makes a mount removable from a config file at all.
    expect(mountsOf(app)).toEqual([{ root: fixtures }])
  })

  it('keeps a third-party option the schema never declared', async () => {
    const setHeaders = (): void => undefined

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .static(s => s.serve(fixtures, { prefix: '/assets/', setHeaders }))
      .build()

    await app.ready()

    // `Value.Clean` strips whatever a schema names, so the mount is carried as an unvalidated bag on purpose.
    expect(mountsOf(app)[0].setHeaders).toBe(setHeaders)
    expect(mountsOf(app)[0].prefix).toBe('/assets/')
  })

  it('lets configuration retune a SPA the application switched on', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .config(c => c.source(new InlineConfigProvider({
        static: { spa: { index: 'index.html', navigationOnly: false } },
      })))
      .static(s => s.spa(dist))
      .build()

    await app.ready()

    const settings = app.container.get(kSPASettings) as SPASettings
    expect(settings.root).toBe(dist)
    expect(settings.navigationOnly).toBe(false)
  })

  // Activation is the builder call, never the tree.
  it('does not switch a SPA on from configuration alone', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .config(c => c.source(new InlineConfigProvider({
        static: { spa: { root: dist } },
      })))
      .static(s => s.serve(fixtures))
      .build()

    await app.ready()

    expect(app.container.getOptional(kSPASettings)).toBeUndefined()
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
    const schema = $t.Object({
      app: $t.Object({
        assets: $t.Object({ mounts: $t.Optional($t.Array($t.Record($t.String(), $t.Unknown()))) }),
      }),
    })

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .config(schema, c => c.source(new InlineConfigProvider({ app: { assets: {} } })))
      // No annotation on the selector: the config type is recovered from the builder.
      .static(s => s.config(c => c.app.assets).serve(fixtures, { prefix: '/moved/' }))
      .build()

    await app.ready()

    expect(mountsOf(app)).toEqual([{ root: fixtures, prefix: '/moved/' }])
  })
})
