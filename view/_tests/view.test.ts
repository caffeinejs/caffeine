import { fileURLToPath } from 'node:url'

import { token } from '@caffeinejs/di'
import { Controller, Get, WebApplication, createWebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import * as ejs from 'ejs'
import handlebars from 'handlebars'
import { afterEach, describe, expect, it } from 'vitest'

import { View, ViewBuilder, ViewEngineBuilder, view } from '../index.js'
import { kBuild } from '../keys.js'

const templatesRoot = fileURLToPath(new URL('./_testdata/templates', import.meta.url))
const ejsRoot = fileURLToPath(new URL('./_testdata/templates-ejs', import.meta.url))

function viewApp() {
  return createWebApplication({}).with(
    view(v => v.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))),
  )
}

describe('view feature', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('renders a view with its model', async () => {
    @Controller('/view-model')
    class ModelController {
      @Get('/show')
      show() {
        return View('hello', { name: 'Ada' })
      }
    }

    void [ModelController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/view-model/show')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('Hello Ada')
  })

  it('renders a view without a model', async () => {
    @Controller('/view-plain')
    class PlainController {
      @Get('/show')
      show() {
        return View('plain')
      }
    }

    void [PlainController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/view-plain/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Static page, no model')
  })

  it('merges defaultContext into the rendered model', async () => {
    @Controller('/view-context')
    class ContextController {
      @Get('/show')
      show() {
        return View('site')
      }
    }

    void [ContextController]

    app = createWebApplication({}).with(
      view(v =>
        v.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs').defaultContext({ site: 'Caffeine' })),
      ),
    )
    await app.bootstrap()

    const res = await app.fetch('/view-context/show')

    expect(await res.text()).toContain('Caffeine')
  })

  it('resolves a namespaced template name against a single root', async () => {
    @Controller('/view-namespaced')
    class NamespacedController {
      @Get('/show')
      show() {
        return View('nested/deep', { name: 'Nested' })
      }
    }

    void [NamespacedController]

    app = createWebApplication({}).with(
      view(v => v.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))),
    )
    await app.bootstrap()

    const res = await app.fetch('/view-namespaced/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Deeply Nested')
  })

  it('renders a view returned from an async handler', async () => {
    @Controller('/view-async')
    class AsyncController {
      @Get('/show')
      async show() {
        return View('hello', { name: 'Grace' })
      }
    }

    void [AsyncController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/view-async/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Hello Grace')
  })

  it('forwards a per-render layout override to reply.view', async () => {
    @Controller('/view-layout')
    class LayoutController {
      @Get('/show')
      show() {
        return View('plain', {}, { layout: 'layout-alt' })
      }
    }

    void [LayoutController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/view-layout/show')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('[ALT]')
    expect(body).toContain('[/ALT]')
    expect(body).toContain('Static page, no model')
  })

  it('leaves non-view handlers untouched (still JSON) when the view feature is enabled', async () => {
    @Controller('/view-json')
    class JsonController {
      @Get('/show')
      show() {
        return { ok: true }
      }
    }

    void [JsonController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/view-json/show')

    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('errors when a handler returns View() but the view feature is not configured', async () => {
    @Controller('/view-unconfigured')
    class UnconfiguredController {
      @Get('/show')
      show() {
        return View('hello', { name: 'Nobody' })
      }
    }

    void [UnconfiguredController]

    app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/view-unconfigured/show')

    expect(res.status).toBe(500)
  })

  it('errors when an async handler returns View() but the view feature is not configured', async () => {
    @Controller('/view-unconfigured-async')
    class UnconfiguredAsyncController {
      @Get('/show')
      async show() {
        return View('hello', { name: 'Nobody' })
      }
    }

    void [UnconfiguredAsyncController]

    app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/view-unconfigured-async/show')

    expect(res.status).toBe(500)
  })

  it('renders each response with its own engine when multiple engines are registered', async () => {
    @Controller('/multi')
    class MultiController {
      // Default engine (handlebars → reply.view).
      @Get('/hbs')
      hbs() {
        return View('hello', { name: 'Ada' })
      }

      // Named engine (ejs → reply.ejs), selected via View options.engine.
      @Get('/ejs')
      ejs() {
        return View('page', { text: 'hi' }, { engine: 'ejs' })
      }
    }

    void [MultiController]

    app = createWebApplication({}).with(
      view(v => {
        v.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))
        v.add('ejs', e => e.engine({ ejs }).root(ejsRoot).extension('ejs'))
      }),
    )
    await app.bootstrap()

    const hbs = await app.fetch('/multi/hbs')
    const ejsRes = await app.fetch('/multi/ejs')

    expect(hbs.status).toBe(200)
    expect(await hbs.text()).toContain('Hello Ada')

    expect(ejsRes.status).toBe(200)
    expect(await ejsRes.text()).toContain('EJS says hi')
  })

  it('selects a named registration of the same engine (distinct layout) via View options.engine', async () => {
    @Controller('/same-engine')
    class SameEngineController {
      // Default handlebars — no layout.
      @Get('/plain')
      plain() {
        return View('plain')
      }

      // Named handlebars registration wrapping the alt layout.
      @Get('/alt')
      alt() {
        return View('plain', {}, { engine: 'alt' })
      }
    }

    void [SameEngineController]

    app = createWebApplication({}).with(
      view(v => {
        v.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))
        v.add('alt', e => e.engine({ handlebars }).root(templatesRoot).extension('hbs').layout('layout-alt'))
      }),
    )
    await app.bootstrap()

    const plain = await app.fetch('/same-engine/plain')
    const alt = await app.fetch('/same-engine/alt')

    const plainBody = await plain.text()
    const altBody = await alt.text()

    expect(plainBody).toContain('Static page, no model')
    expect(plainBody).not.toContain('[ALT]')

    expect(altBody).toContain('[ALT]')
    expect(altBody).toContain('[/ALT]')
    expect(altBody).toContain('Static page, no model')
  })

  it('errors when a handler selects an engine that was never registered', async () => {
    @Controller('/multi-missing')
    class MissingEngineController {
      @Get('/show')
      show() {
        return View('hello', { name: 'Ada' }, { engine: 'nope' })
      }
    }

    void [MissingEngineController]

    app = viewApp()
    await app.bootstrap()

    const res = await app.fetch('/multi-missing/show')

    expect(res.status).toBe(500)
  })

  // The configure callback runs when the application bootstraps, so an authoring mistake inside it surfaces
  // from `bootstrap()` rather than from the `.with(...)` call that wrote it.
  it('rejects registering an engine named "view" (reserved for the default engine)', async () => {
    const rejected = createWebApplication({}).with(
      view(v => v.add('view', e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))),
    )

    await expect(rejected.bootstrap()).rejects.toThrow(/reserved for the default engine/)
  })

  it('refuses a view plugin with no engine configured', async () => {
    app = createWebApplication({}).with(view())

    await expect(app.bootstrap()).rejects.toThrow(/Cannot install the view plugin: no engine was configured/)
  })
})

describe('ViewEngineBuilder', () => {
  it('assembles the configured options', () => {
    const options = new ViewEngineBuilder().engine({ handlebars }).root(templatesRoot).extension('hbs')[kBuild]() as {
      root: string
      viewExt: string
      engine: unknown
      propertyName?: string
    }

    expect(options.root).toBe(templatesRoot)
    expect(options.viewExt).toBe('hbs')
    expect(options.engine).toEqual({ handlebars })
    // The default (unnamed) engine carries no propertyName — it decorates reply.view.
    expect(options.propertyName).toBeUndefined()
  })

  it('stamps propertyName for a named engine', () => {
    const options = new ViewEngineBuilder('mobile')
      .engine({ handlebars })
      .root(templatesRoot)
      .extension('hbs')
      [kBuild]() as {
      propertyName?: string
    }

    expect(options.propertyName).toBe('mobile')
  })

  it('throws when no engine was configured', () => {
    expect(() => new ViewEngineBuilder().root(templatesRoot)[kBuild]()).toThrow(/Engine is required/)
  })

  it('accepts an array root (for engines that support multiple roots, e.g. Nunjucks)', () => {
    const roots = [templatesRoot, `${templatesRoot}/nested`]
    const options = new ViewEngineBuilder().engine({ handlebars }).root(roots)[kBuild]() as unknown as {
      root: string[]
    }

    expect(options.root).toEqual(roots)
  })

  it('configure() merges a full options object over prior settings (last write wins)', () => {
    // configure overrides the earlier viewExt; a later fluent setter overrides configure.
    const options = new ViewEngineBuilder()
      .engine({ handlebars })
      .extension('hbs')
      .configure({ charset: 'ascii', viewExt: 'html' })
      .extension('pug')
      [kBuild]() as { charset: string; viewExt: string }

    expect(options.charset).toBe('ascii')
    expect(options.viewExt).toBe('pug')
  })

  // A deployment can move the templates without touching code, and a setting written in code stands.
  it('config() fills in what no method set', () => {
    const options = new ViewEngineBuilder()
      .config({ root: templatesRoot, viewExt: 'html', production: true })
      .engine({ handlebars })
      .extension('hbs')
      [kBuild]() as { root: string; viewExt: string; production: boolean }

    expect(options.root).toBe(templatesRoot)
    expect(options.viewExt).toBe('hbs')
    expect(options.production).toBe(true)
  })

  // `engine(e)` without engine options leaves them unset; it must not erase the ones the configuration carries.
  it('config() keeps its engine options when engine() names none', () => {
    const options = new ViewEngineBuilder()
      .config({ options: { strict: true } })
      .engine({ handlebars })
      [kBuild]() as {
      options: object
    }

    expect(options.options).toEqual({ strict: true })
  })

  it('renders from the root and extension the configuration names', async () => {
    @Controller('/view-configured')
    class ConfiguredController {
      @Get('/show')
      show() {
        return View('hello', { name: 'Grace' })
      }
    }

    void [ConfiguredController]

    const schema = $t.Object({
      view: $t.Object({ root: $t.Optional($t.String()), viewExt: $t.Optional($t.String()) }, { default: {} }),
    })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('view.config.test'))
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ view: { root: templatesRoot, viewExt: 'hbs' } }))
      .build()
    const app = createWebApplication({ config: conf }).with(
      view<InferConfig<typeof schema>>((v, { config }) => v.add(e => e.config(config.view).engine({ handlebars }))),
    )

    try {
      await app.bootstrap()

      const res = await app.fetch('/view-configured/show')

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Hello Grace')
    } finally {
      await app.close()
    }
  })
})

describe('ViewBuilder', () => {
  it('groups the default and named engines, default first, stamping propertyName', () => {
    const builder = new ViewBuilder()
    builder.add(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))
    builder.add('ejs', e => e.engine({ ejs }).root(ejsRoot).extension('ejs'))

    const all = builder[kBuild]() as Array<{ propertyName?: string }>

    expect(all).toHaveLength(2)
    expect(all[0].propertyName).toBeUndefined()
    expect(all[1].propertyName).toBe('ejs')
  })

  it('rejects a second engine with the same name', () => {
    const builder = new ViewBuilder()
    builder.add('mobile', e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))

    expect(() => builder.add('mobile', e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))).toThrow(
      /already configured/,
    )
  })

  it('rejects the reserved engine name', () => {
    expect(() => new ViewBuilder().add('view', e => e.engine({ handlebars }))).toThrow(
      /reserved for the default engine/,
    )
  })
})
