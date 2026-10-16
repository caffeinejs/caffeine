import { describe, it, expect } from 'vitest'

import {
  Catch,
  type IContext,
  Controller,
  ErrConfiguration,
  ErrHTTPNotFound,
  Get,
  type ActionResult,
} from '../../../index.js'
import { createWebApplication } from '../../../platform/fastify/index.js'

// Isolated: two controller methods handling the same error type. buildRouting rejects at bootstrap(),
// which poisons every app build in the module — so it lives alone.
@Controller('/dup')
class DupController {
  @Get('/')
  get(): ActionResult {
    throw new ErrHTTPNotFound('x')
  }

  @Catch(ErrHTTPNotFound)
  async first(_ctx: IContext, _error: ErrHTTPNotFound): Promise<void> {}

  @Catch(ErrHTTPNotFound)
  async second(_ctx: IContext, _error: ErrHTTPNotFound): Promise<void> {}
}
void [DupController]

describe('duplicate controller error handler', () => {
  it('rejects when two methods handle the same error type, naming the controller', async () => {
    const app = createWebApplication()
    const started = app.bootstrap()

    await expect(started).rejects.toThrow(ErrConfiguration)
    // By its name: the class itself would print its whole source.
    await expect(started).rejects.toThrow(
      /^Ambiguous controller error handler: multiple handlers registered for "ErrHTTPNotFound" in "DupController"/,
    )
  })
})
