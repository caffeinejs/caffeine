import { fileURLToPath } from 'node:url'

import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { afterEach, describe, expect, it } from 'vitest'

import type { ViewBuilder } from '../builder.js'
import { viewConfigSchema } from '../config.js'
import { view } from '../plugin.js'

// The application owns the schema: it declares one block per view engine — by importing the feature's own
// schema, given a default so a block a test never configures still materializes.
const engineSchema = $t.Object(viewConfigSchema.properties, { default: {} })
const rootSchema = $t.Object({
  view: $t.Object({ default: engineSchema, mail: engineSchema }, { default: {} }),
})
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const templatesRoot = fileURLToPath(new URL('./_testdata/templates', import.meta.url))
const ejsRoot = fileURLToPath(new URL('./_testdata/templates-ejs', import.meta.url))

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

// The options the plugin registers `@fastify/view` with, read after `ready()` so they reflect whatever the
// configure callback wired.
const capture = () => {
  let builder: ViewBuilder<never> | undefined

  return {
    take: <B>(b: B): B => {
      builder = b as ViewBuilder<never>
      return b
    },
    options: (): Array<Record<string, unknown>> => (builder?.all() ?? []) as unknown as Array<Record<string, unknown>>,
  }
}

describe('view configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // A fluent method is the last word. The environment names a root here and the callback never wired it, so
  // the root the code set is what the engine runs on.
  it('keeps a builder-set root when the callback does not read the configuration', async () => {
    const engines = capture()

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ VIEW__DEFAULT__ROOT: ejsRoot }), ConfigPriority.ENV))
      .extend(view(v => engines.take(v).engine(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))))
      .build()

    await app.ready()

    const [options] = engines.options()
    expect(options.root).toBe(templatesRoot)
  })

  // Wire it, and the environment is what the engine runs on — per key, so a setting the environment does not
  // name keeps the value the code gave it. Named exception: view is config-wins once `withConfig` is wired.
  it('reads a root from the environment when the callback wires the block', async () => {
    const engines = capture()

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ VIEW__DEFAULT__ROOT: ejsRoot }), ConfigPriority.ENV))
      .extend(
        view((v, c) =>
          engines
            .take(v)
            .engine(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs').withConfig(c.view.default)),
        ),
      )
      .build()

    await app.ready()

    const [options] = engines.options()
    expect(options.root).toBe(ejsRoot)
    // Untouched by the environment, so the code value still stands.
    expect(options.viewExt).toBe('hbs')
  })

  // The engine is a module object full of functions and cannot travel through the tree at all.
  it('keeps the code-only engine after configuration is applied', async () => {
    const engines = capture()

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            view: { default: { root: templatesRoot, production: true } },
          }),
        ),
      )
      .extend(
        view((v, c) =>
          engines.take(v).engine(e => e.engine({ handlebars }).extension('hbs').withConfig(c.view.default)),
        ),
      )
      .build()

    await app.ready()

    const [options] = engines.options()
    expect(options.engine).toEqual({ handlebars })
    expect(options.production).toBe(true)
  })

  // One feature, several engines: each reads its own block, and the named one stamps `propertyName`.
  it('keeps named engines apart, each at the block it was pointed at', async () => {
    const engines = capture()

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            view: { mail: { viewExt: 'from-config' } },
          }),
        ),
      )
      .extend(
        view((v, c) => {
          engines.take(v)
          v.engine(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs').withConfig(c.view.default))
          v.engine('mail', e => e.engine({ handlebars }).root(templatesRoot).extension('ejs').withConfig(c.view.mail))
        }),
      )
      .build()

    await app.ready()

    const [def, mail] = engines.options()
    expect(def.viewExt).toBe('hbs')
    expect(def.propertyName).toBeUndefined()
    expect(mail.viewExt).toBe('from-config')
    expect(mail.propertyName).toBe('mail')
  })

  // Where the block lives is the application's choice, and the callback is what names it.
  it('reads the settings from wherever the application put the block', async () => {
    const engines = capture()
    const schema = $t.Object({
      app: $t.Object({
        templates: $t.Object({ viewExt: $t.Optional($t.String()) }),
      }),
    })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(schema, kConfig, c =>
        c.source(
          new InlineConfigProvider({
            app: { templates: { viewExt: 'moved' } },
          }),
        ),
      )
      .extend(
        view((v, c) =>
          engines.take(v).engine(e => e.engine({ handlebars }).root(templatesRoot).withConfig(c.app.templates)),
        ),
      )
      .build()

    await app.ready()

    expect(engines.options()[0].viewExt).toBe('moved')
  })

  it('refuses a view feature with no engine configured', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(view())
      .build()

    await expect(app.ready()).rejects.toThrow(/Cannot install the view feature: no engine was configured/)
  })
})
