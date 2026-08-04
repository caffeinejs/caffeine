import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, ErrBadRequest, ErrConflict, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'

// No @Catch handlers in this file: thrown ErrHTTP errors fall through to the adapter's envelope.
@Controller('/http-err')
class HTTPErrController {
  @Get('/conflict')
  conflict(): unknown {
    throw new ErrConflict('nope')
  }

  @Get('/zero-body')
  zero(): unknown {
    throw new ErrBadRequest('bad', { body: 0 })
  }
}
void [HTTPErrController]

describe('ErrHTTP envelope fallback', () => {
  it('renders the status and a structured envelope for an unhandled ErrHTTP', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'nope',
      code: 'HTTP_ERROR',
      statusCode: 409,
      message: 'nope',
    })
  })

  it('sends a falsy-but-defined body verbatim instead of the envelope', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/http-err/zero-body')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('0')
  })
})
