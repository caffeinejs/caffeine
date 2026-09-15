import { fileURLToPath } from 'node:url'

import {
  Catch,
  type ActionResult,
  type Context,
  Controller,
  ErrorHandler,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { describe, it, expect } from 'vitest'

import { View, view } from '../index.js'

// An error handler, like a controller handler, may RETURN a View() which the framework renders as HTML.
// This exercises the view plugin on the error-handling path.

const templatesRoot = fileURLToPath(new URL('./_testdata/templates', import.meta.url))

class ErrReturnView extends Error {}

@Catch(ErrReturnView)
class ReturnViewHandler extends ErrorHandler<ErrReturnView> {
  handle(ctx: Context, error: ErrReturnView): ActionResult {
    ctx.status(404)
    return View('message', { message: error.message })
  }
}

@Controller('/err-return-view')
class ErrReturnController {
  @Get('/view')
  view(): unknown {
    throw new ErrReturnView('as html')
  }
}

void [ReturnViewHandler, ErrReturnController]

describe('error handler returning a View()', () => {
  it('renders a returned View() as HTML', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()), {}).with(
      view(v => v.engine(e => e.engine({ handlebars }).root(templatesRoot).extension('hbs'))),
    )
    await app.ready()

    const res = await app.fetch('/err-return-view/view')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('as html')
  })
})
