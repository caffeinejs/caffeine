import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { type ActionResult, Catch, IContext, ErrHTTPNotFound, ErrorHandler } from '../index.js'
import { node } from '../platform/node/index.js'

@Catch(ErrHTTPNotFound)
class GlobalNotFound implements ErrorHandler<ErrHTTPNotFound> {
  handle(ctx: IContext, error: ErrHTTPNotFound): ActionResult {
    return ctx.status(404).body({ caught: true, message: error.message })
  }
}

describe('@Catch and unmatched routes', () => {
  it('an enrolled @Catch(ErrHTTPNotFound) sees a URL that matched no route', async () => {
    const app = createWebApplication({ adapter: node() }).errorHandling(e => e.globalHandlers(GlobalNotFound))
    await app.bootstrap()

    const res = await app.request('/definitely-not-a-route')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ caught: true })
    expect(((await (await app.request('/another-miss')).json()) as Record<string, unknown>).message).toContain(
      '/another-miss',
    )

    await app.close()
  })
})
