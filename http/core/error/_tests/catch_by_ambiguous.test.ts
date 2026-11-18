import { describe, it, expect } from 'vitest'

import { createWebApplication } from '../../../application.js'
import {
  Catch,
  CatchWith,
  type IContext,
  Controller,
  ErrConfiguration,
  ErrorHandler,
  Get,
  type ActionResult,
} from '../../../index.js'
import { node } from '../../../platform/node/index.js'

// Both handlers cover ErrAmbiguous, and one @CatchWith names them both.
class ErrAmbiguous extends Error {}

@Catch(ErrAmbiguous)
class FirstHandler implements ErrorHandler<ErrAmbiguous> {
  async handle(_ctx: IContext, _error: ErrAmbiguous): Promise<void> {}
}

@Catch(ErrAmbiguous)
class SecondHandler implements ErrorHandler<ErrAmbiguous> {
  async handle(_ctx: IContext, _error: ErrAmbiguous): Promise<void> {}
}
void [FirstHandler, SecondHandler]

@CatchWith(FirstHandler, SecondHandler)
@Controller('/ambiguous')
class AmbiguousController {
  @Get('/')
  boom(): ActionResult {
    throw new ErrAmbiguous('boom')
  }
}
void [AmbiguousController]

describe('ambiguous @CatchWith', () => {
  it('rejects when two referenced handlers cover the same error type', async () => {
    const app = createWebApplication({ adapter: node() })

    await expect(app.bootstrap()).rejects.toThrow(ErrConfiguration)
  })
})
