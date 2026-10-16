import { afterAll, beforeAll, describe, it, expect } from 'vitest'

import { Catch, type IContext, Controller, ErrorHandler, Get, Responder, ActionResult } from './index.js'
import { createWebApplication } from './platform/fastify/index.js'

// A custom response kind with NO view/Fastify involvement: it renders itself through the platform-neutral
// Context API alone. Proves the adapter dispatches any ResponseResult subclass, not just ViewResult, and
// that a result can render without touching Fastify reply specifics.
class TextResult extends Responder {
  constructor(readonly body: string) {
    super()
  }

  respond(ctx: IContext): ActionResult {
    ctx.header('x-render', 'custom').header('content-type', 'text/plain').body(this.body)
  }
}

class ErrCustom extends Error {}

@Catch(ErrCustom)
class CustomErrorHandler implements ErrorHandler<ErrCustom> {
  handle(ctx: IContext, error: ErrCustom): ActionResult {
    ctx.status(422)
    return new TextResult(`caught: ${error.message}`)
  }
}

@Controller('/custom')
class CustomController {
  @Get('/sync')
  sync(): ActionResult {
    return new TextResult('hello sync')
  }

  @Get('/async')
  async async(): Promise<ActionResult> {
    return new TextResult('hello async')
  }

  @Get('/json')
  json(): ActionResult {
    return { ok: true }
  }

  @Get('/boom')
  boom(): ActionResult {
    throw new ErrCustom('kaboom')
  }
}

void [CustomController]

describe('custom ResponseResult dispatch', () => {
  async function buildApp() {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(CustomErrorHandler))
    await app.bootstrap()
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

describe('number, boolean and null results', () => {
  @Controller('/scalar')
  class ScalarController {
    @Get('/sync/0')
    syncZero(): number {
      return 0
    }

    @Get('/sync/1')
    syncOne(): number {
      return 1
    }

    @Get('/sync/true')
    syncTrue(): boolean {
      return true
    }

    @Get('/sync/false')
    syncFalse(): boolean {
      return false
    }

    @Get('/sync/null')
    syncNull(): null {
      return null
    }

    @Get('/sync/undefined')
    syncUndefined(): undefined {
      return undefined
    }

    @Get('/async/0')
    async asyncZero(): Promise<number> {
      return 0
    }

    @Get('/async/1')
    async asyncOne(): Promise<number> {
      return 1
    }

    @Get('/async/true')
    async asyncTrue(): Promise<boolean> {
      return true
    }

    @Get('/async/false')
    async asyncFalse(): Promise<boolean> {
      return false
    }

    @Get('/async/null')
    async asyncNull(): Promise<null> {
      return null
    }
  }

  void [ScalarController]

  const app = createWebApplication()

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  describe.each(['sync', 'async'])('%s handler', handler => {
    // Each path names what its handler returns, written as the JSON text the body must be.
    it.each(['0', '1', 'true', 'false', 'null'])('sends %s as a JSON body', async json => {
      const res = await app.fetch(`/scalar/${handler}/${json}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      expect(await res.text()).toBe(json)
    })
  })

  it('still sends an empty body for undefined', async () => {
    const res = await app.fetch('/scalar/sync/undefined')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
