import { ErrApplicationNotReady, ErrApplicationStarted } from '@caffeinejs/application'
import { afterEach, describe, expect, it, expectTypeOf } from 'vitest'

import { type WebApplication, type WebRunInfo, createWebApplication } from './application.js'
import { ErrConfiguration, HTTPPlugin, Router } from './index.js'
import { node, type NodeAdapter } from './platform/node.testkit.js'

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
    app = createWebApplication({ adapter: node() }).mount(router) as WebApplication
    await app.bootstrap()

    const { request } = app

    expect(await (await request(new Request('http://localhost/detached'))).json()).toEqual({ ok: true })
  })

  it('has no server to reach before bootstrap()', async () => {
    const built = createWebApplication({ adapter: node() }).mount(new Router('/hi').get('/').handler(() => 'hi'))

    expect(() => built.instance).toThrow(ErrApplicationNotReady)
    await expect(built.request('/hi')).rejects.toThrow(ErrApplicationNotReady)
    expect(built.address).toBeUndefined()

    // Closing what never readied is fine: there is nothing to tear down.
    await built.close()
  })

  // Like the server, the route table exists only once start-up has built it.
  it('has no route table to read before bootstrap()', async () => {
    const built = createWebApplication({ adapter: node() }).mount(new Router('/hi').get('/').handler(() => 'hi'))
    app = built as WebApplication

    expect(() => built.routeGroups).toThrow(ErrApplicationNotReady)

    await built.bootstrap()
    expect(built.routeGroups.some(group => group.path === '/hi')).toBe(true)
  })

  // A router mounted while start-up runs another router's plugins is served, so its own plugins must run too, even
  // when that other router is on a listener whose routers are resolved after the application's.
  it("runs the plugins of a router mounted while a listener router's plugin factories run", async () => {
    let registered = 0
    const late = new Router('/late')
      .with(
        () =>
          new (class extends HTTPPlugin {
            register(): void {
              registered++
            }
          })(),
      )
      .get('/', () => 'late')
    const built = createWebApplication({ adapter: node() })
    const first = new Router('/first')
      .with(() => {
        built.mount(late)
        return new (class extends HTTPPlugin {
          register(): void {}
        })()
      })
      .get('/', () => 'first')
    app = built.listener('admin', l => l.mount(first)) as WebApplication

    await app.bootstrap()

    expect((await app.request('/late')).status).toBe(200)
    expect(registered).toBe(1)
  })
})

describe('the fetch application', () => {
  it('builds from the package root and answers app.fetch', async () => {
    const app = createWebApplication().mount(new Router('/hello').get('/').handler(() => 'hi'))
    await app.bootstrap()

    try {
      expect(await (await app.fetch(new Request('http://x/hello'))).text()).toBe('hi')
    } finally {
      await app.close()
    }
  })

  it('throws ErrApplicationNotReady from app.fetch before bootstrap', () => {
    const app = createWebApplication()

    expect(() => app.fetch(new Request('http://x/'))).toThrow(ErrApplicationNotReady)
  })

  // Code expecting a listener's address does not compile against an application that opens no socket.
  it('resolves run() with no address', async () => {
    const app = createWebApplication()

    const info = await app.run()

    try {
      expect('address' in info).toBe(false)
      expectTypeOf(info).not.toHaveProperty('address')
    } finally {
      await app.close()
    }
  })

  it("keeps address on the Node application's run()", () => {
    expectTypeOf<
      Awaited<ReturnType<WebApplication<never, never, unknown, NodeAdapter>['run']>>
    >().toEqualTypeOf<WebRunInfo>()
  })

  it('hands over no server instance once ready, since no adapter built one', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    try {
      expect(app.instance).toBe(undefined)
    } finally {
      await app.close()
    }
  })

  // A caller the types did not stop, since the parameter is `never` under no adapter: refused where it wrote the call.
  it('refuses serverCallback, since there is no server to hand over', () => {
    const app = createWebApplication()
    let failure: unknown

    try {
      app.serverCallback((() => undefined) as never)
    } catch (err) {
      failure = err
    }

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as ErrConfiguration).code).toBe('ERR_CONFIGURATION')
    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot call serverCallback: the application has no adapter, so no server to hand over',
    )
  })
})

describe('createWebApplication({ adapter })', () => {
  // A JavaScript caller, or one past a cast, is refused at once rather than served by no adapter at all.
  it('refuses an adapter that is not one', () => {
    let failure: unknown

    try {
      createWebApplication({ adapter: {} as never })
    } catch (err) {
      failure = err
    }

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as ErrConfiguration).code).toBe('ERR_CONFIGURATION')
    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot create the application: "adapter" is not a server adapter',
    )
  })

  // An adapter built against another copy of this package carries that copy's hosting key, which this one cannot read.
  it('tells the reader to install one copy of @caffeinejs/http when the adapter comes from another', () => {
    const fromAnotherCopy = { [Symbol('@caffeinejs/http:hosting')]: () => ({}) }

    expect(() => createWebApplication({ adapter: fromAnotherCopy as never })).toThrow(
      'Install @caffeinejs/http and @caffeinejs/http-node at the same exact version, so both load one copy of @caffeinejs/http',
    )
  })
})

describe('WebApplication.hook()', () => {
  // A hook added once the server is built would never be installed: refused so the caller finds out.
  it('refuses a hook once bootstrap has started', async () => {
    const fetchApp = createWebApplication()
    await fetchApp.bootstrap()

    try {
      expect(() => fetchApp.hook('onRequest', () => undefined)).toThrow(ErrApplicationStarted)
    } finally {
      await fetchApp.close()
    }
  })

  it('refuses a point that is not a hook, for a caller the types did not stop', () => {
    expect(() => createWebApplication().hook('preValidation' as 'onRequest', () => undefined)).toThrow(ErrConfiguration)
  })
})
