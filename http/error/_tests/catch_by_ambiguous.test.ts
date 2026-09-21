import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  CatchWith,
  type Context,
  Controller,
  ErrConfiguration,
  ErrorHandler,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../index.js'

// Both handlers cover ErrAmbiguous, and one @CatchWith names them both.
class ErrAmbiguous extends Error {}

@Catch(ErrAmbiguous)
class FirstHandler implements ErrorHandler<ErrAmbiguous> {
  async handle(_ctx: Context, _error: ErrAmbiguous): Promise<void> {}
}

@Catch(ErrAmbiguous)
class SecondHandler implements ErrorHandler<ErrAmbiguous> {
  async handle(_ctx: Context, _error: ErrAmbiguous): Promise<void> {}
}
void [FirstHandler, SecondHandler]

@CatchWith(FirstHandler, SecondHandler)
@Controller('/ambiguous')
class AmbiguousController {
  @Get('/')
  boom(): unknown {
    throw new ErrAmbiguous('boom')
  }
}
void [AmbiguousController]

describe('ambiguous @CatchWith', () => {
  it('rejects when two referenced handlers cover the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
