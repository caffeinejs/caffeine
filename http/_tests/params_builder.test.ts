import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { $p, Controller, Get, Params, createWebApplication, fastifyAdapterFactory } from '../index.js'

// @Params accepts either an array of `$p` pickers or a builder function that receives the builtin pickers.
// Both must resolve handler arguments identically.
@Controller('/pb')
class ParamsBuilderController {
  @Get('/fn/:id')
  @Params(p => [p.param('id'), p.query('q')])
  fn(id: string, q: string): unknown {
    return { id, q }
  }

  @Get('/arr/:id')
  @Params([$p.param('id'), $p.query('q')])
  arr(id: string, q: string): unknown {
    return { id, q }
  }
}

void [ParamsBuilderController]

describe('@Params builder signature', () => {
  it('resolves the same arguments from the function form as the array form', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    try {
      const fn = await app.fetch('/pb/fn/42?q=hello')
      const arr = await app.fetch('/pb/arr/42?q=hello')

      expect(fn.status).toBe(200)
      expect(await fn.json()).toEqual({ id: '42', q: 'hello' })
      expect(await arr.json()).toEqual({ id: '42', q: 'hello' })
    } finally {
      await app.close()
    }
  })
})
