import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Injectable } from '@caffeinejs/di'
import { type Context, ErrConfiguration, ErrorHandler, createWebApplication, fastifyAdapterFactory } from '../../index.js'

// Isolated: extends the base handler but forgets @Catch. This poisons every app build in its
// module, so it must be the only error-handler concern in this file.
@Injectable()
class UntaggedHandler extends ErrorHandler<Error> {
  async handle(_ctx: Context, _error: Error): Promise<void> {}
}
void [UntaggedHandler]

describe('untagged error handler', () => {
  it('rejects a handler that does not declare an error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
