import { describe, it, expect } from 'vitest'

import { Catch, Controller, ErrConfiguration, ErrHTTPNotFound, Get, type ActionResult } from '../../../index.js'
import { createWebApplication } from '../../../platform/fastify/index.js'

// Isolated: a single method is both a route (@Get) and an error handler (@Catch). buildRouting
// rejects at bootstrap(), poisoning every app build in the module — so it lives alone.
@Controller('/both')
class BothController {
  @Get('/')
  @Catch(ErrHTTPNotFound)
  handle(): ActionResult {
    throw new ErrHTTPNotFound('x')
  }
}
void [BothController]

describe('route method used as an error handler', () => {
  it('rejects a method that is both a route and a @Catch handler, naming the controller', async () => {
    const app = createWebApplication()
    const started = app.bootstrap()

    await expect(started).rejects.toThrow(ErrConfiguration)
    // By its name: the class itself would print its whole source.
    await expect(started).rejects.toThrow(
      /^Method "handle" in "BothController" cannot be both a route and an error handler/,
    )
  })
})
