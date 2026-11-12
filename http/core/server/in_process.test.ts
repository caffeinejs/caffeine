import { Readable } from 'node:stream'

import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { FetchAdapterTypes } from './adapter.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any, any>
type FetchApp = WebApplication<FetchAdapterTypes, any, any, any>

let app: FetchApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serve(router: AnyRouter, container = new CaffeineIoC()): Promise<FetchApp> {
  app = createWebApplication({ container }).mount(router)
  await app.bootstrap()
  return app
}

describe('requestInProcess', () => {
  it('resolves a path against http://localhost', async () => {
    const served = await serve(new Router('/h').get('/').handler(ctx => ctx.req.host))

    expect(await (await served.request('/h')).text()).toBe('localhost')
  })

  it('takes a Request and a URL as fetch does', async () => {
    const served = await serve(new Router('/a').get('/').handler(ctx => ctx.req.host))

    for (const input of [new Request('http://x/a'), new URL('http://x/a')]) {
      const res = await served.request(input)

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('x')
    }
  })

  it('rejects at once with the reason of an aborted signal', async () => {
    const served = await serve(new Router('/a').get('/').handler(() => 'a'))
    const reason = new Error('gone')

    await expect(served.request('/a', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })

  it('rejects with the reason when the signal aborts while the handler runs, and aborts ctx.signal', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => (started = resolve))
    let signal: AbortSignal | undefined
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const served = await serve(
      new Router('/a').get('/').handler(async ctx => {
        signal = ctx.signal
        started()
        await held
        return 'late'
      }),
    )
    const controller = new AbortController()
    const reason = new Error('client left')

    const pending = served.request('/a', { signal: controller.signal })
    await running
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(signal?.aborted).toBe(true)
    release()
  })

  // Every chunk is produced after the handler returned, re-resolving the request-scoped binding: a scope torn down
  // at hand-off would show up as a destroyed or a different instance.
  it('keeps the request scope alive while the response streams', async () => {
    let created = 0
    const teardowns: number[] = []
    let notify: () => void = () => undefined
    class Session {
      readonly id = ++created
      destroyed = false
    }
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
    const router = new Router('/scope-stream')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        const handlerSession = deps.session.get()
        let pushed = 0

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
    const served = await serve(router, container)
    const teardown = new Promise<void>(resolve => (notify = resolve))

    const res = await served.request('/scope-stream')

    expect(await res.text()).toBe('1:false:true\n1:false:true\n1:false:true\n')
    await teardown
    expect(teardowns).toEqual([1])
  })

  // The container is disposed after close(): a body nobody read must not keep its request scope past it.
  it('lets close() finish with an in-process body left unread, and releases its request scope', async () => {
    const destroyed: string[] = []
    class Session {}
    const container = new CaffeineIoC()
    container.bind(Session, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(() => void destroyed.push('session')),
    )
    const router = new Router('/s')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        return new ReadableStream<Uint8Array>()
      })
    const served = await serve(router, container)

    await served.request('/s')
    await served.close()
    app = undefined

    expect(destroyed).toEqual(['session'])
  })
})
