import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { Catch, type Context, Controller, ErrorHandler, Get, View, createWebApplication, fastifyAdapterFactory } from '../../index.js'

// Error handlers, like controller handlers, may RETURN a value the framework finalizes: a View() renders
// as HTML, a plain object serializes as JSON, and a handler that responds via ctx (returning void) is
// unchanged.

const templatesRoot = fileURLToPath(new URL('./templates', import.meta.url))

class ErrReturnView extends Error {}
class ErrReturnJson extends Error {}
class ErrReturnVoid extends Error {}

@Catch(ErrReturnView)
class ReturnViewHandler extends ErrorHandler<ErrReturnView> {
  handle(ctx: Context, error: ErrReturnView): unknown {
    ctx.status(404)
    return View('message', { message: error.message })
  }
}

@Catch(ErrReturnJson)
class ReturnJsonHandler extends ErrorHandler<ErrReturnJson> {
  handle(ctx: Context, error: ErrReturnJson): unknown {
    ctx.status(418)
    return { code: 'TEAPOT', message: error.message }
  }
}

@Catch(ErrReturnVoid)
class ReturnVoidHandler extends ErrorHandler<ErrReturnVoid> {
  async handle(ctx: Context, error: ErrReturnVoid): Promise<void> {
    ctx.status(500).body({ viaCtx: error.message })
  }
}

@Controller('/err-return')
class ErrReturnController {
  @Get('/view')
  view(): unknown { throw new ErrReturnView('as html') }

  @Get('/json')
  json(): unknown { throw new ErrReturnJson('as json') }

  @Get('/void')
  void(): unknown { throw new ErrReturnVoid('via ctx') }
}

void [ReturnViewHandler, ReturnJsonHandler, ReturnVoidHandler, ErrReturnController]

describe('error handler return values', () => {
  it('renders a returned View() as HTML', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .view(v => v.engine({ handlebars }).root(templatesRoot).viewExt('hbs'))
      .build()
    await app.ready()

    const res = await app.fetch('/err-return/view')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('as html')
  })

  it('serializes a returned object as JSON', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .view(v => v.engine({ handlebars }).root(templatesRoot).viewExt('hbs'))
      .build()
    await app.ready()

    const res = await app.fetch('/err-return/json')

    expect(res.status).toBe(418)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ code: 'TEAPOT', message: 'as json' })
  })

  it('leaves a ctx-based (void-returning) handler unchanged', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .view(v => v.engine({ handlebars }).root(templatesRoot).viewExt('hbs'))
      .build()
    await app.ready()

    const res = await app.fetch('/err-return/void')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ viaCtx: 'via ctx' })
  })
})
