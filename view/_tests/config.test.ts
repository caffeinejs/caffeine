import { fileURLToPath } from 'node:url'

import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { afterEach, describe, expect, it } from 'vitest'

import { ViewExtension } from '../extension.js'
import { ViewExt } from '../plugin.js'

// The application declares no configuration of its own — `view.*` belongs to the feature — but a source
// cannot be registered without a schema, so the root names that block and leaves its contents to the
// feature's own slice.
const rootSchema = $t.Object({ view: $t.Record($t.String(), $t.Unknown(), { default: {} }) })
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const templatesRoot = fileURLToPath(new URL('./_testdata/templates', import.meta.url))
const ejsRoot = fileURLToPath(new URL('./_testdata/templates-ejs', import.meta.url))

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

const optionsOf = (app: WebApplication): Array<Record<string, unknown>> =>
  app.container.get(ViewExtension).provider.all() as unknown as Array<Record<string, unknown>>

describe('view configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lets the environment override a builder-set root', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ VIEW__DEFAULT__ROOT: ejsRoot }), ConfigPriority.ENV))
      .extend(ViewExt, v => v.engine({ handlebars }).root(templatesRoot).extension('hbs'))
      .build()

    await app.ready()

    const [options] = optionsOf(app)
    expect(options.root).toBe(ejsRoot)
    // Untouched by the environment, so the code value still stands.
    expect(options.viewExt).toBe('hbs')
  })

  // The engine is a module object full of functions and cannot travel through the tree at all.
  it('keeps the code-only engine after configuration is applied', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            view: { default: { root: templatesRoot, production: true } },
          }),
        ),
      )
      .extend(ViewExt, v => v.engine({ handlebars }).extension('hbs'))
      .build()

    await app.ready()

    const [options] = optionsOf(app)
    expect(options.engine).toEqual({ handlebars })
    expect(options.production).toBe(true)
  })

  it('keeps named engines apart, the unnamed one at view.default', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            view: { mail: { viewExt: 'from-config' } },
          }),
        ),
      )
      .extend(ViewExt, v => v.engine({ handlebars }).root(templatesRoot).extension('hbs'))
      .extend(ViewExt('mail'), v => v.engine({ handlebars }).root(templatesRoot).extension('ejs'))
      .build()

    await app.ready()

    const [def, mail] = optionsOf(app)
    expect(def.viewExt).toBe('hbs')
    expect(def.propertyName).toBeUndefined()
    expect(mail.viewExt).toBe('from-config')
    expect(mail.propertyName).toBe('mail')
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
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
      // No annotation on the selector: the config type is recovered from the builder.
      .extend(ViewExt, v =>
        v
          .config(c => c.app.templates)
          .engine({ handlebars })
          .root(templatesRoot),
      )
      .build()

    await app.ready()

    expect(optionsOf(app)[0].viewExt).toBe('moved')
  })
})
