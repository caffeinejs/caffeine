import { describe, it, expect } from 'vitest'

import {
  Catch,
  type Context,
  Controller,
  ErrHTTPBadRequest,
  ErrHTTPConflict,
  ErrorHandler,
  Get,
  createWebApplication,
} from '../index.js'

@Controller('/http-err')
class HTTPErrController {
  @Get('/conflict')
  conflict(): unknown {
    throw new ErrHTTPConflict('nope')
  }

  @Get('/zero-body')
  zero(): unknown {
    throw new ErrHTTPBadRequest('bad', { body: 0 })
  }

  @Get('/with-headers')
  headers(): unknown {
    throw new ErrHTTPBadRequest('bad', { headers: { 'x-detail': 'why' } })
  }
}
void [HTTPErrController]

// Declared in the same module as the tests that assert the default envelope, and deliberately so: a handler
// class nobody enrols renders nothing, so it cannot reach the applications built below.
@Catch(ErrHTTPConflict)
class NeverEnrolledHandler implements ErrorHandler<ErrHTTPConflict> {
  async handle(ctx: Context, _error: ErrHTTPConflict): Promise<void> {
    ctx.status(418).body({ enrolled: true })
  }
}
void [NeverEnrolledHandler]

describe('ErrHTTP envelope fallback', () => {
  it('renders the status and a structured envelope for an unhandled ErrHTTP', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(409)
    // `error` is the status phrase, `message` the detail — the two are not interchangeable.
    expect(await res.json()).toEqual({
      error: 'Conflict',
      code: 'ERR_HTTP_CONFLICT',
      statusCode: 409,
      message: 'nope',
    })

    await app.close()
  })

  it('sends a falsy-but-defined body verbatim instead of the envelope', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/zero-body')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('0')

    await app.close()
  })

  // `headers` is optional and stays undefined when the error carries none, so this is the only path that
  // reaches reply.headers at all.
  it('applies the headers an ErrHTTP carries', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/with-headers')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-detail')).toBe('why')

    await app.close()
  })

  // The envelope is what an application gets for free. A @Catch class declared anywhere in the process used to
  // replace it by being imported; now only the application naming the handler does.
  it('keeps the envelope when a matching handler was declared but never enrolled', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ERR_HTTP_CONFLICT' })

    await app.close()
  })

  it('replaces the envelope once the application enrols that same handler', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(NeverEnrolledHandler))
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ enrolled: true })

    await app.close()
  })
})
