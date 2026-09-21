import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  type Context,
  Controller,
  ErrorHandler,
  Get,
  Responder,
  ActionResult,
  createWebApplication,
  fastifyAdapterFactory,
} from './index.js'

// A custom response kind with NO view/Fastify involvement: it renders itself through the platform-neutral
// Context API alone. Proves the adapter dispatches any ResponseResult subclass, not just ViewResult, and
// that a result can render without touching Fastify reply specifics.
class TextResult extends Responder {
  constructor(readonly body: string) {
    super()
  }

  respond(ctx: Context): ActionResult {
    ctx.header('x-render', 'custom').header('content-type', 'text/plain').body(this.body)
  }
}

class ErrCustom extends Error {}

@Catch(ErrCustom)
class CustomErrorHandler implements ErrorHandler<ErrCustom> {
  handle(ctx: Context, error: ErrCustom): ActionResult {
    ctx.status(422)
    return new TextResult(`caught: ${error.message}`)
  }
}

@Controller('/custom')
class CustomController {
  @Get('/sync')
  sync(): unknown {
    return new TextResult('hello sync')
  }

  @Get('/async')
  async async(): Promise<unknown> {
    return new TextResult('hello async')
  }

  @Get('/json')
  json(): unknown {
    return { ok: true }
  }

  @Get('/boom')
  boom(): unknown {
    throw new ErrCustom('kaboom')
  }
}

void [CustomController]

describe('custom ResponseResult dispatch', () => {
  async function buildApp() {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).errorHandling(e =>
      e.globalHandlers(CustomErrorHandler),
    )
    await app.ready()
    return app
  }

  it('dispatches a custom result returned from a sync handler', async () => {
    const app = await buildApp()

    const res = await app.fetch('/custom/sync')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-render')).toBe('custom')
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('hello sync')

    await app.close()
  })

  it('dispatches a custom result resolved from an async handler', async () => {
    const app = await buildApp()

    const res = await app.fetch('/custom/async')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-render')).toBe('custom')
    expect(await res.text()).toBe('hello async')

    await app.close()
  })

  it('leaves a plain object untouched (still JSON) when no protocol symbol is present', async () => {
    const app = await buildApp()

    const res = await app.fetch('/custom/json')

    expect(res.headers.get('x-render')).toBeNull()
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true })

    await app.close()
  })

  it('dispatches a custom result returned from an error handler', async () => {
    const app = await buildApp()

    const res = await app.fetch('/custom/boom')

    expect(res.status).toBe(422)
    expect(res.headers.get('x-render')).toBe('custom')
    expect(await res.text()).toBe('caught: kaboom')

    await app.close()
  })
})
