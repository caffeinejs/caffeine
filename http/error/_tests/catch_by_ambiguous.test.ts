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

// Isolated: the ambiguity poisons every app build in its module, so it must be the only
// error-handler concern in this file.
class ErrAmbiguous extends Error {}

@Catch(ErrAmbiguous, { global: false })
class FirstHandler extends ErrorHandler<ErrAmbiguous> {
  async handle(_ctx: Context, _error: ErrAmbiguous): Promise<void> {}
}

@Catch(ErrAmbiguous, { global: false })
class SecondHandler extends ErrorHandler<ErrAmbiguous> {
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
