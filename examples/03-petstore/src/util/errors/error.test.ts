import { fileURLToPath } from 'node:url'

import {
  Catch,
  CatchWith,
  type Context,
  Controller,
  ErrHTTPNotFound,
  ErrHTTPUnauthorized,
  ErrorHandler,
  Get,
  Post,
  Schema,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { view } from '@caffeinejs/view'
import fastify from 'fastify'
import handlebars from 'handlebars'
import { describe, it, expect } from 'vitest'

// Side-effect import: registers HTTPErrorHandler / FallbackErrorHandler as global @Catch handlers.
import './error.handlers.js'
import type { ErrorBody } from './error.handlers.js'

// A throwing controller exercising each error path the global handlers cover.
@Controller('/things')
class ThingsController {
  @Get('/', p => [p.query()])
  @Schema({ querystring: $t.Object({ n: $t.Optional($t.Integer()) }) })
  list(query: unknown): unknown {
    return query
  }

  @Post('/', p => [p.body()])
  @Schema({ body: $t.Object({ name: $t.String() }) })
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

  @Get('/:id', p => [p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`The requested thing with ID "${id}" was not found`)
  }
}
void [ThingsController]

// A controller that opts out of the global rendering for 404s only. The handler is declared
// { global: false } so it does not compete with HTTPErrorHandler, and is attached with @CatchWith —
// which takes precedence over the global handler for this controller alone.
@Catch(ErrHTTPNotFound, { global: false })
class SilentNotFoundHandler extends ErrorHandler<ErrHTTPNotFound> {
  async handle(ctx: Context, _err: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ found: false })
  }
}
void [SilentNotFoundHandler]

@CatchWith(SilentNotFoundHandler)
@Controller('/gadgets')
class GadgetsController {
  @Get('/:id', p => [p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`No gadget "${id}"`)
  }

  @Get('/boom')
  boom(): unknown {
    throw new Error('kaboom')
  }
}
void [GadgetsController]

const viewsRoot = fileURLToPath(new URL('../../views', import.meta.url))

async function buildApp() {
  const app = createWebApplication(fastifyAdapterFactory(fastify()), {}).with(
    view(v => v.add(e => e.engine({ handlebars }).root(viewsRoot).extension('hbs').layout('layout'))),
  )
  await app.ready()
  return app
}

describe('error handling', () => {
  it('renders a thrown ErrHTTPNotFound as a 404 { code, message }', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/abc')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'The requested thing with ID "abc" was not found',
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
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as ErrorBody
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.errors).toEqual([{ field: 'name', message: expect.any(String) }])
  })

  it('renders a querystring-validation failure as 400 without a field list', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things?n=not-a-number')

    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as ErrorBody
    expect(body.code).toBe('BAD_REQUEST')
    expect(body).not.toHaveProperty('errors')
  })

  it('renders a thrown ErrHTTPUnauthorized as a 401 { code, message }', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/denied')

    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid credentials',
    })
  })

  it('renders an unexpected error as a 500 INTERNAL_ERROR', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(((await res.json()) as ErrorBody).code).toBe('INTERNAL_ERROR')
  })

  it('renders an HTML error page when the client accepts text/html', async () => {
    const app = await buildApp()

    const res = await app.fetch('/things/abc', {
      headers: { accept: 'text/html' },
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Error 404')
    // Handlebars escapes the double-quotes in the message ("abc" → &quot;abc&quot;).
    expect(html).toContain('The requested thing with ID &quot;abc&quot; was not found')
  })

  it('lets a controller override the global 404 rendering with @CatchWith', async () => {
    const app = await buildApp()

    const res = await app.fetch('/gadgets/abc')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ found: false })
  })

  it('still falls back to the global handler for types the @CatchWith handler does not cover', async () => {
    const app = await buildApp()

    const res = await app.fetch('/gadgets/boom')

    expect(res.status).toBe(500)
    expect(((await res.json()) as ErrorBody).code).toBe('INTERNAL_ERROR')
  })
})
