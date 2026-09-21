import { describe, it, expect } from 'vitest'

import { Catch, Controller, ErrConfiguration, ErrHTTPNotFound, Get, createWebApplication } from '../../index.js'

// Isolated: a single method is both a route (@Get) and an error handler (@Catch). buildRouting
// rejects at ready(), poisoning every app build in the module — so it lives alone.
@Controller('/both')
class BothController {
  @Get('/')
  @Catch(ErrHTTPNotFound)
  handle(): unknown {
    throw new ErrHTTPNotFound('x')
  }
}
void [BothController]

describe('route method used as an error handler', () => {
  it('rejects a method that is both a route and a @Catch handler', async () => {
    const app = createWebApplication()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
