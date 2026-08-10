import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Catch, CatchBy, type Context, Controller, ErrHTTPNotFound, ErrHTTPUnauthorized, ErrorHandler, Get, Params, Post, Schema, createWebApplication, fastifyAdapterFactory, $p } from '@caffeinejs/http'
// Side-effect import: registers HTTPProblemHandler / FallbackProblemHandler as global @Catch handlers.
import './problem.handlers.js'
import type { ProblemDetails } from './problem.js'

// A throwing controller exercising each error path the global handlers cover.
@Controller('/things')
class ThingsController {
  @Get('/')
  @Schema({ querystring: { type: 'object', properties: { n: { type: 'integer' } } } })
  @Params([$p.query()])
  list(query: unknown): unknown {
    return query
  }

  @Post('/')
  @Schema({ body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } })
  @Params([$p.body()])
  create(body: unknown): unknown {
    return body
  }

  @Get('/boom')
  boom(): unknown {
    throw new Error('kaboom')
  }

  @Get('/denied')
  denied(): unknown {
    throw new ErrHTTPUnauthorized('Invalid credentials')
  }

  @Get('/:id')
  @Params([$p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`The requested thing with ID "${id}" was not found`)
  }
}
void [ThingsController]

// A controller that opts out of the global problem+json rendering for 404s only. The handler is
// declared { global: false } so it does not compete with HTTPProblemHandler, and is attached with
// @CatchBy — which takes precedence over the global handler for this controller alone.
@Catch(ErrHTTPNotFound, { global: false })
class SilentNotFoundHandler extends ErrorHandler<ErrHTTPNotFound> {
  async handle(ctx: Context, _err: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ found: false })
  }
}
void [SilentNotFoundHandler]

@CatchBy(SilentNotFoundHandler)
@Controller('/gadgets')
class GadgetsController {
  @Get('/:id')
  @Params([$p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`No gadget "${id}"`)
  }

  @Get('/boom')
  boom(): unknown {
    throw new Error('kaboom')
  }
}
void [GadgetsController]

async function buildApp() {
  const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
  await app.ready()
  return app
}

describe('RFC 9457 problem+json error handling', () => {
  it('renders a thrown ErrHTTPNotFound as 404 problem+json', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/abc')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(await res.json()).toEqual({
      type: 'https://petstoreapi.com/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'The requested thing with ID "abc" was not found',
      instance: '/things/abc',
    })
  })

  it('renders a body-validation failure as 422 with a field error list', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json() as ProblemDetails
    expect(body.type).toBe('https://petstoreapi.com/errors/validation-error')
    expect(body.status).toBe(422)
    expect(body.instance).toBe('/things')
    expect(body.errors).toEqual([{ field: 'name', message: expect.any(String), code: 'required' }])
  })

  it('renders a querystring-validation failure as 400 problem+json', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things?n=not-a-number')

    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json() as ProblemDetails
    expect(body.type).toBe('https://petstoreapi.com/errors/bad-request')
    expect(body.status).toBe(400)
    expect(body).not.toHaveProperty('errors')
  })

  it('renders a thrown ErrHTTPUnauthorized as 401 problem+json', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/denied')

    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json() as ProblemDetails
    expect(body.type).toBe('https://petstoreapi.com/errors/unauthorized')
    expect(body.status).toBe(401)
    expect(body.detail).toBe('Invalid credentials')
  })

  it('renders an unexpected error as 500 problem+json', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json() as ProblemDetails
    expect(body.type).toBe('https://petstoreapi.com/errors/internal-server-error')
    expect(body.status).toBe(500)
  })

  it('lets a controller override the global 404 rendering with @CatchBy', async () => {
    const app = await buildApp()

    const res = await app.fetch('/gadgets/abc')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ found: false })
  })

  it('still falls back to the global handler for types the @CatchBy handler does not cover', async () => {
    const app = await buildApp()

    const res = await app.fetch('/gadgets/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json() as ProblemDetails
    expect(body.type).toBe('https://petstoreapi.com/errors/internal-server-error')
  })
})
