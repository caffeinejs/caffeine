import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../../application.js'
import { Router } from './programmatic.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('Router.mount', () => {
  // An empty mount path is a path like any other: it adds nothing, and is never taken for a router.
  it('mounts a router at an empty path as at none', async () => {
    app = createWebApplication().mount(
      new Router('/r').mount(
        '',
        new Router().get('/x', () => 'x'),
      ),
    ) as WebApplication
    await app.bootstrap()

    expect((await app.request('/r/x')).status).toBe(200)
  })
})
