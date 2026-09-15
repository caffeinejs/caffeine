import { Readable } from 'node:stream'

import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Router, createWebApplication } from '../index.js'

/**
 * The request scope has to live as long as the response, not as long as the handler's promise. Everything here
 * resolves a request-scoped binding *after* the handler settled — through an await, through a stream still
 * being piped — which is exactly what a scope torn down with the handler cannot serve.
 */
describe('request scope lifetime', () => {
  /** A fresh class per test, so ids and teardowns are never shared between them. */
  function fixture() {
    let created = 0
    const teardowns: number[] = []
    let notify: () => void = () => {}

    class Session {
      readonly id = ++created
      destroyed = false
    }

    function newApp() {
      const container = new CaffeineIoC()
      container.bind(Session, t =>
        t
          .toSelf()
          .lifetime(Scopes.REQUEST)
          .preDestroy(session => {
            session.destroyed = true
            teardowns.push(session.id)
            notify()
          }),
      )
      return createWebApplication({ container })
    }

    /** Resolves on the next teardown. Call it before the request that should trigger one. */
    function nextTeardown() {
      return new Promise<void>(resolve => {
        notify = resolve
      })
    }

    return { Session, teardowns, newApp, nextTeardown }
  }

  it('keeps the request scope alive across an await in the handler', async () => {
    const { Session, newApp } = fixture()

    const router = new Router('/scope-await')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler(async (_ctx, deps) => {
        const first = deps.session.get()
        await new Promise(resolve => setTimeout(resolve, 10))
        const second = deps.session.get()

        return { same: first === second, destroyed: first.destroyed }
      })

    const app = newApp().mount(router)
    await app.ready()

    const res = await app.fetch('/scope-await')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ same: true, destroyed: false })

    await app.close()
  })

  it('keeps the request scope alive while the response streams', async () => {
    const { Session, teardowns, newApp, nextTeardown } = fixture()

    const router = new Router('/scope-stream')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        const handlerSession = deps.session.get()
        let pushed = 0

        // Every chunk is produced from a timer, so all of them are written long after the handler returned
        // this stream to the adapter. Each one re-resolves, so a scope that was torn down in between shows up
        // as a different instance.
        return new Readable({
          read() {
            if (pushed === 3) {
              this.push(null)
              return
            }

            pushed++
            setTimeout(() => {
              const session = deps.session.get()
              this.push(`${session.id}:${session.destroyed}:${session === handlerSession}\n`)
            }, 5)
          },
        })
      })

    const app = newApp().mount(router)
    await app.ready()

    const teardown = nextTeardown()
    const res = await app.fetch('/scope-stream')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('1:false:true\n1:false:true\n1:false:true\n')

    // And the instance the stream used is destroyed once the response is over — not left behind because the
    // scope had already ended when it was created.
    await teardown

    expect(teardowns).toEqual([1])

    await app.close()
  })

  it('destroys the request scope once, after the response, and gives the next request a new one', async () => {
    const { Session, teardowns, newApp, nextTeardown } = fixture()

    const router = new Router('/scope-once')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => ({ id: deps.session.get().id }))

    const app = newApp().mount(router)
    await app.ready()

    let teardown = nextTeardown()
    expect(await (await app.fetch('/scope-once')).json()).toEqual({ id: 1 })
    await teardown
    expect(teardowns).toEqual([1])

    teardown = nextTeardown()
    expect(await (await app.fetch('/scope-once')).json()).toEqual({ id: 2 })
    await teardown
    expect(teardowns).toEqual([1, 2])

    await app.close()
  })

  it('destroys the request scope when the handler throws', async () => {
    const { Session, teardowns, newApp, nextTeardown } = fixture()

    const router = new Router('/scope-throws')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        throw new Error('handler failed')
      })

    const app = newApp().mount(router)
    await app.ready()

    const teardown = nextTeardown()
    const res = await app.fetch('/scope-throws')

    expect(res.status).toBe(500)

    await teardown

    expect(teardowns).toEqual([1])

    await app.close()
  })
})
