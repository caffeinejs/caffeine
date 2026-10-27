import { afterEach, describe, expect, it } from 'vitest'

import type { WebApplication } from './application.js'
import { Router } from './index.js'
import { createWebApplication } from './platform/fastify/index.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('WebApplication', () => {
  // A client handed the method alone, as a `fetch` of its own, calls it with no `this`.
  it('answers through request handed on as a bare function', async () => {
    const router = new Router('/detached')
    router.get('/').handler(() => ({ ok: true }))
    app = createWebApplication().mount(router) as WebApplication
    await app.bootstrap()

    const { request } = app

    expect(await (await request(new Request('http://localhost/detached'))).json()).toEqual({ ok: true })
  })
})
