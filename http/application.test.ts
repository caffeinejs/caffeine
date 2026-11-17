import { ErrApplicationNotReady, ErrApplicationStarted } from '@caffeinejs/application'
import { afterEach, describe, expect, it, expectTypeOf } from 'vitest'

import { createWebApplication as createFetchApplication, type WebApplication, type WebRunInfo } from './application.js'
import { ErrConfiguration, Router } from './index.js'
import { createWebApplication } from './platform/node/index.js'

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

describe('the fetch application', () => {
  it('builds from the package root and answers app.fetch', async () => {
    const app = createFetchApplication().mount(new Router('/hello').get('/').handler(() => 'hi'))
    await app.bootstrap()

    try {
      expect(await (await app.fetch(new Request('http://x/hello'))).text()).toBe('hi')
    } finally {
      await app.close()
    }
  })

  it('throws ErrApplicationNotReady from app.fetch before bootstrap', () => {
    const app = createFetchApplication()

    expect(() => app.fetch(new Request('http://x/'))).toThrow(ErrApplicationNotReady)
  })

  // Code expecting a listener's address does not compile against an application that opens no socket.
  it('resolves run() with no address', async () => {
    const app = createFetchApplication()

    const info = await app.run()

    try {
      expect('address' in info).toBe(false)
      expectTypeOf(info).not.toHaveProperty('address')
    } finally {
      await app.close()
    }
  })

  it("keeps address on the Node application's run()", () => {
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof createWebApplication>['run']>>>().toEqualTypeOf<WebRunInfo>()
  })
})

describe('WebApplication.hook()', () => {
  // A hook added once the server is built would never be installed: refused so the caller finds out.
  it('refuses a hook once bootstrap has started', async () => {
    const fetchApp = createFetchApplication()
    await fetchApp.bootstrap()

    try {
      expect(() => fetchApp.hook('onRequest', () => undefined)).toThrow(ErrApplicationStarted)
    } finally {
      await fetchApp.close()
    }
  })

  it('refuses a point that is not a hook, for a caller the types did not stop', () => {
    expect(() => createFetchApplication().hook('preValidation' as 'onRequest', () => undefined)).toThrow(
      ErrConfiguration,
    )
  })
})
