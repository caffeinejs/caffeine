import { Injectable } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  type Context,
  ErrConfiguration,
  ErrorHandler,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../index.js'

// Bound, and shaped like a handler, but it never declared which errors it renders.
@Injectable()
class UntaggedHandler implements ErrorHandler<Error> {
  async handle(_ctx: Context, _error: Error): Promise<void> {}
}

describe('untagged error handler', () => {
  it('rejects a handler enrolled without an error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).errorHandling(e =>
      e.globalHandlers(UntaggedHandler),
    )

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  // Declaring a class is no longer what puts it to work, so the same class nobody enrolled is inert rather
  // than a start-up failure.
  it('ignores the same handler when it is not enrolled', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))

    await app.ready()

    await app.close()
  })
})
