import { describe, it, expect } from 'vitest'

import { Catch, type ActionResult, type IContext, Controller, ErrorHandler, Get } from '../../../index.js'
import { createWebApplication } from '../../../platform/fastify/index.js'

// Error handlers, like controller handlers, may RETURN a value the framework finalizes: a plain object
// serializes as JSON, and a handler that responds via ctx (returning void) is unchanged.

class ErrReturnJson extends Error {}
class ErrReturnVoid extends Error {}

@Catch(ErrReturnJson)
class ReturnJsonHandler implements ErrorHandler<ErrReturnJson> {
  handle(ctx: IContext, error: ErrReturnJson): ActionResult {
    ctx.status(418)
    return { code: 'TEAPOT', message: error.message }
  }
}

@Catch(ErrReturnVoid)
class ReturnVoidHandler implements ErrorHandler<ErrReturnVoid> {
  async handle(ctx: IContext, error: ErrReturnVoid): Promise<void> {
    ctx.status(500).body({ viaCtx: error.message })
  }
}

@Controller('/err-return')
class ErrReturnController {
  @Get('/json')
  json(): ActionResult {
    throw new ErrReturnJson('as json')
  }

  @Get('/void')
  void(): ActionResult {
    throw new ErrReturnVoid('via ctx')
  }
}

void [ErrReturnController]

describe('error handler return values', () => {
  it('serializes a returned object as JSON', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(ReturnJsonHandler, ReturnVoidHandler))
    await app.bootstrap()

    const res = await app.request('/err-return/json')

    expect(res.status).toBe(418)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ code: 'TEAPOT', message: 'as json' })
  })

  it('leaves a ctx-based (void-returning) handler unchanged', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(ReturnJsonHandler, ReturnVoidHandler))
    await app.bootstrap()

    const res = await app.request('/err-return/void')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ viaCtx: 'via ctx' })
  })
})
