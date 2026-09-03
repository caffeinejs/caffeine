import { describe, expect, it } from 'vitest'
import fastify from 'fastify'
import {
  type ActionResult,
  Catch,
  Context,
  ErrHTTPNotFound,
  ErrorHandler,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

// In its own file: a global @Catch handler applies to every application built in the module, so leaving it
// beside the envelope tests would make them assert this handler's body instead of the default one.
@Catch(ErrHTTPNotFound)
class GlobalNotFound extends ErrorHandler<ErrHTTPNotFound> {
  handle(ctx: Context, error: ErrHTTPNotFound): ActionResult {
    return ctx.status(404).body({ caught: true, message: error.message })
  }
}

describe('@Catch and unmatched routes', () => {
  it('a global @Catch(ErrHTTPNotFound) sees a URL that matched no route', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    app.container.bind(GlobalNotFound, t => t.toClass(GlobalNotFound).extends(ErrorHandler))
    await app.ready()

    const res = await app.fetch('/definitely-not-a-route')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ caught: true })
    expect((await (await app.fetch('/another-miss')).json() as Record<string, unknown>).message)
      .toContain('/another-miss')

    await app.close()
  })
})
