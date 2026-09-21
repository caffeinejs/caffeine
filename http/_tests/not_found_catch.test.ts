import { describe, expect, it } from 'vitest'

import { type ActionResult, Catch, Context, ErrHTTPNotFound, ErrorHandler, createWebApplication } from '../index.js'

@Catch(ErrHTTPNotFound)
class GlobalNotFound implements ErrorHandler<ErrHTTPNotFound> {
  handle(ctx: Context, error: ErrHTTPNotFound): ActionResult {
    return ctx.status(404).body({ caught: true, message: error.message })
  }
}

describe('@Catch and unmatched routes', () => {
  it('an enrolled @Catch(ErrHTTPNotFound) sees a URL that matched no route', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(GlobalNotFound))
    await app.ready()

    const res = await app.fetch('/definitely-not-a-route')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ caught: true })
    expect(((await (await app.fetch('/another-miss')).json()) as Record<string, unknown>).message).toContain(
      '/another-miss',
    )

    await app.close()
  })
})
