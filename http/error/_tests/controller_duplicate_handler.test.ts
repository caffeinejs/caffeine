import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Catch, type Context, Controller, ErrConfiguration, ErrNotFound, Get, createWebApplication, fastifyAdapterFactory } from '../../index.js'

// Isolated: two controller methods handling the same error type. buildRouting rejects at ready(),
// which poisons every app build in the module — so it lives alone.
@Controller('/dup')
class DupController {
  @Get('/')
  get(): unknown {
    throw new ErrNotFound('x')
  }

  @Catch(ErrNotFound)
  async first(_ctx: Context, _error: ErrNotFound): Promise<void> {}

  @Catch(ErrNotFound)
  async second(_ctx: Context, _error: ErrNotFound): Promise<void> {}
}
void [DupController]

describe('duplicate controller error handler', () => {
  it('rejects when two methods handle the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
