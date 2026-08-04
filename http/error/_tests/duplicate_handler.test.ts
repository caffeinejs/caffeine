import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Catch, type Context, ErrConfiguration, ErrNotFound, ErrorHandler, createWebApplication, fastifyAdapterFactory } from '../../index.js'

// Isolated: two handlers for the same error type. The ambiguity poisons every app build in its
// module, so it must be the only error-handler concern in this file.
@Catch(ErrNotFound)
class FirstHandler extends ErrorHandler<ErrNotFound> {
  async handle(_ctx: Context, _error: ErrNotFound): Promise<void> {}
}

@Catch(ErrNotFound)
class SecondHandler extends ErrorHandler<ErrNotFound> {
  async handle(_ctx: Context, _error: ErrNotFound): Promise<void> {}
}
void [FirstHandler, SecondHandler]

describe('ambiguous error handler', () => {
  it('rejects when two handlers target the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
