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
  // A client that takes a `fetch` of its own calls it as a bare function, with no `this`.
  it('answers through fetch handed on as a bare function', async () => {
    const router = new Router('/detached')
    router.get('/').handler(() => ({ ok: true }))
    app = createWebApplication().mount(router) as WebApplication
    await app.bootstrap()

    const { fetch } = app

    expect(await (await fetch(new Request('http://localhost/detached'))).json()).toEqual({ ok: true })
  })
})
