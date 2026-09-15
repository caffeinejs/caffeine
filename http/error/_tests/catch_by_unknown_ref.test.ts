import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  CatchWith,
  type Context,
  Controller,
  ErrConfiguration,
  ErrorHandler,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../index.js'

// Isolated: the unresolvable reference poisons every app build in its module, so it must be the only
// error-handler concern in this file.
class UnboundHandler extends ErrorHandler<Error> {
  async handle(_ctx: Context, _error: Error): Promise<void> {}
}

@CatchWith(UnboundHandler)
@Controller('/unknown')
class UnknownRefController {
  @Get('/')
  boom(): unknown {
    throw new Error('boom')
  }
}
void [UnknownRefController]

describe('@CatchWith with an unregistered handler', () => {
  it('rejects when the referenced handler has no binding', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
