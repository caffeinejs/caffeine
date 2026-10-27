import { describe, it, expect } from 'vitest'

import { $p, Controller, Get, Args, type ActionResult } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

// @Args accepts either an array of `$p` pickers or a builder function that receives the builtin pickers.
// Both must resolve handler arguments identically.
@Controller('/pb')
class ParamsBuilderController {
  @Get('/fn/:id')
  @Args(p => [p.param('id'), p.query('q')])
  fn(id: string, q: string): ActionResult {
    return { id, q }
  }

  @Get('/arr/:id')
  @Args([$p.param('id'), $p.query('q')])
  arr(id: string, q: string): ActionResult {
    return { id, q }
  }
}

void [ParamsBuilderController]

describe('@Args builder signature', () => {
  it('resolves the same arguments from the function form as the array form', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    try {
      const fn = await app.request('/pb/fn/42?q=hello')
      const arr = await app.request('/pb/arr/42?q=hello')

      expect(fn.status).toBe(200)
      expect(await fn.json()).toEqual({ id: '42', q: 'hello' })
      expect(await arr.json()).toEqual({ id: '42', q: 'hello' })
    } finally {
      await app.close()
    }
  })
})
