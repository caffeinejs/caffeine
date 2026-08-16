import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { CaffeineIoC } from '@caffeinejs/di'
import {
  Controller,
  Get,
  View,
  ViewBuilder,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
  kViewOptions,
} from '../../index.js'
import { Feats } from '../../feats.js'
import { kServiceConfigure } from '../../service.js'

const templatesRoot = fileURLToPath(new URL('./templates', import.meta.url))

function viewApp() {
  return createWebApplication(fastifyAdapterFactory(fastify()))
    .view(v => v.engine({ handlebars }).root(templatesRoot).extension('hbs'))
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
      show() { return View('hello', { name: 'Ada' }) }
    }

    void [ModelController]

    app = viewApp().build()
    await app.ready()

    const res = await app.fetch('/view-model/show')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('Hello Ada')
  })

  it('renders a view without a model', async () => {
    @Controller('/view-plain')
    class PlainController {
      @Get('/show')
      show() { return View('plain') }
    }

    void [PlainController]

    app = viewApp().build()
    await app.ready()

    const res = await app.fetch('/view-plain/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Static page, no model')
  })

  it('merges defaultContext into the rendered model', async () => {
    @Controller('/view-context')
    class ContextController {
      @Get('/show')
      show() { return View('site') }
    }

    void [ContextController]

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .view(v => v.engine({ handlebars }).root(templatesRoot).extension('hbs').defaultContext({ site: 'Caffeine' }))
      .build()
    await app.ready()

    const res = await app.fetch('/view-context/show')

    expect(await res.text()).toContain('Caffeine')
  })

  it('resolves a namespaced template name against a single root', async () => {
    @Controller('/view-namespaced')
    class NamespacedController {
      @Get('/show')
      show() { return View('nested/deep', { name: 'Nested' }) }
    }

    void [NamespacedController]

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .view(v => v.engine({ handlebars }).root(templatesRoot).extension('hbs'))
      .build()
    await app.ready()

    const res = await app.fetch('/view-namespaced/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Deeply Nested')
  })

  it('renders a view returned from an async handler', async () => {
    @Controller('/view-async')
    class AsyncController {
      @Get('/show')
      async show() { return View('hello', { name: 'Grace' }) }
    }

    void [AsyncController]

    app = viewApp().build()
    await app.ready()

    const res = await app.fetch('/view-async/show')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Hello Grace')
  })

  it('forwards a per-render layout override to reply.view', async () => {
    @Controller('/view-layout')
    class LayoutController {
      @Get('/show')
      show() { return View('plain', {}, { layout: 'layout-alt' }) }
    }

    void [LayoutController]

    app = viewApp().build()
    await app.ready()

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
      show() { return { ok: true } }
    }

    void [JsonController]

    app = viewApp().build()
    await app.ready()

    const res = await app.fetch('/view-json/show')

    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('errors when a handler returns View() but the view feature is not configured', async () => {
    @Controller('/view-unconfigured')
    class UnconfiguredController {
      @Get('/show')
      show() { return View('hello', { name: 'Nobody' }) }
    }

    void [UnconfiguredController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/view-unconfigured/show')

    expect(res.status).toBe(500)
  })

  it('errors when an async handler returns View() but the view feature is not configured', async () => {
    @Controller('/view-unconfigured-async')
    class UnconfiguredAsyncController {
      @Get('/show')
      async show() { return View('hello', { name: 'Nobody' }) }
    }

    void [UnconfiguredAsyncController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/view-unconfigured-async/show')

    expect(res.status).toBe(500)
  })
})

describe('ViewBuilder', () => {
  it('binds the assembled options to kViewOptions', async () => {
    const container = new CaffeineIoC()
    const builder = new ViewBuilder()
    builder.engine({ handlebars }).root(templatesRoot).extension('hbs')

    await builder[kServiceConfigure]({ container, feats: new Feats() })
    await container.init()

    const options = container.get<{ root: string, viewExt: string, engine: unknown }>(kViewOptions)
    expect(options.root).toBe(templatesRoot)
    expect(options.viewExt).toBe('hbs')
    expect(options.engine).toEqual({ handlebars })
  })

  it('binds an array root (for engines that support multiple roots, e.g. Nunjucks)', async () => {
    const container = new CaffeineIoC()
    const roots = [templatesRoot, `${templatesRoot}/nested`]
    const builder = new ViewBuilder()
    builder.engine({ handlebars }).root(roots)

    await builder[kServiceConfigure]({ container, feats: new Feats() })
    await container.init()

    const options = container.get<{ root: string[] }>(kViewOptions)
    expect(options.root).toEqual(roots)
  })

  it('configure() merges a full options object over prior settings (last write wins)', async () => {
    const container = new CaffeineIoC()
    const builder = new ViewBuilder()
    // configure overrides the earlier viewExt; a later fluent setter overrides configure.
    builder.engine({ handlebars }).extension('hbs').configure({ charset: 'ascii', viewExt: 'html' }).extension('pug')

    await builder[kServiceConfigure]({ container, feats: new Feats() })
    await container.init()

    const options = container.get<{ charset: string, viewExt: string }>(kViewOptions)
    expect(options.charset).toBe('ascii')
    expect(options.viewExt).toBe('pug')
  })
})
