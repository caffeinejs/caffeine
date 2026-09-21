import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  type Context,
  ErrConfiguration,
  ErrHTTPNotFound,
  ErrorHandler,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../index.js'

// Two handlers for the same error type. Declaring both is fine — enrolling both is what the application
// cannot mean, because nothing then decides which one renders an ErrHTTPNotFound.
@Catch(ErrHTTPNotFound)
class FirstHandler implements ErrorHandler<ErrHTTPNotFound> {
  async handle(_ctx: Context, _error: ErrHTTPNotFound): Promise<void> {}
}

@Catch(ErrHTTPNotFound)
class SecondHandler implements ErrorHandler<ErrHTTPNotFound> {
  async handle(_ctx: Context, _error: ErrHTTPNotFound): Promise<void> {}
}

describe('ambiguous error handler', () => {
  it('rejects when two enrolled handlers target the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).errorHandling(e =>
      e.globalHandlers(FirstHandler, SecondHandler),
    )

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  // The pair only conflicts because both were named. Declaring a second handler for an error type some other
  // controller renders with @CatchWith is not itself an error, which is the whole point of enrolment.
  it('accepts the same two handlers when only one is enrolled', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).errorHandling(e =>
      e.globalHandlers(FirstHandler),
    )

    await app.ready()

    await app.close()
  })
})
