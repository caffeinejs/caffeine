import assert from 'node:assert'
import { once } from 'node:events'

import { ErrApplicationClosed } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrHTTPServiceUnavailable } from '../../core/error/http.js'
import { Router, type AnyRouter } from '../../index.js'
import { createWebApplication } from './node.js'

type App = ReturnType<typeof createWebApplication>

const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  // A close a failed test left waiting on a fake timer is let go, and the clock restored, before anything closes.
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  }
  await Promise.all(apps.splice(0).map(app => app.close()))
})

async function ready(routes: AnyRouter): Promise<App> {
  const app = createWebApplication().mount(routes)
  apps.push(app)
  await app.bootstrap()
  return app
}

describe('request() on the Node application', () => {
  // A dead application stops answering as if it still served: a test that reaches one after close() learns it at once.
  it('rejects with ErrApplicationClosed once close() has torn the server down', async () => {
    const routes = new Router('/a')
    routes.get('/hi').handler(() => 'hi')
    const app = await ready(routes)
    expect((await app.request('/a/hi')).status).toBe(200)

    await app.close()

    await expect(app.request('/a/hi')).rejects.toBeInstanceOf(ErrApplicationClosed)
  })

  // A forced close cuts what is still in flight, as it destroys a socket's: the caller is never handed an answer the
  // handler did not give, and learns why as on the fetch application.
  it('fails a pending call that a forced close cuts with the 503 error, rather than answering it 500', async () => {
    const started = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const routes = new Router('/hold')
    routes.get('/').handler(async () => {
      started.resolve()
      await held.promise
      return 'late'
    })
    const app = createWebApplication()
      .logger(b => b.use(newNoopLogger()))
      .shutdown(s => s.drainDelay(0).shutdownTimeout(1 * Second))
      .mount(routes)
    apps.push(app)
    await app.bootstrap()

    const outcome = app.request('/hold').then(
      res => res.status,
      (err: unknown) => err,
    )
    await started.promise

    // The budget's clock is driven; the close's own `setImmediate` stays real, so each step yields a real tick.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const closing = app.close().then(
      () => (settled = true),
      () => (settled = true),
    )
    while (!settled) {
      await vi.advanceTimersByTimeAsync(1 * Second)
      await new Promise(resolve => setImmediate(resolve))
    }
    vi.useRealTimers()
    await closing
    held.resolve()

    const err = (await outcome) as Error
    expect(err).toBeInstanceOf(ErrHTTPServiceUnavailable)
    expect(err.message).toBe('The server was closed')
  })

  // The in-process response asks for more as it is read, which is no failure: a streamed answer is sent whole and
  // nothing is logged.
  it('sends a streamed answer whole and logs no failure', async () => {
    const error = vi.fn()
    const routes = new Router('/s')
    routes.get('/').handler(() => {
      let sent = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 4) {
            controller.close()
            return
          }
          sent++
          controller.enqueue(new Uint8Array(64 * 1024).fill(1))
        },
      })
    })
    const app = createWebApplication()
      .logger(b => b.use({ ...newNoopLogger(), error }))
      .mount(routes)
    apps.push(app)
    await app.bootstrap()

    const body = await (await app.request('/s')).arrayBuffer()
    await app.close()

    expect(body.byteLength).toBe(4 * 64 * 1024)
    expect(error).not.toHaveBeenCalled()
  })

  it('serves a path on localhost through the Node platform, seen from 127.0.0.1', async () => {
    const routes = new Router('/who')
    routes.get('/').handler(ctx => {
      assert(ctx.platform.name === 'node')
      return {
        platform: ctx.platform.name,
        address: ctx.platform.incoming.socket.remoteAddress,
        host: ctx.req.host,
      }
    })
    const app = await ready(routes)

    expect(await (await app.request('/who')).json()).toEqual({
      platform: 'node',
      address: '127.0.0.1',
      host: 'localhost',
    })
  })

  it('streams an upload the handler reads from ctx.req.raw', async () => {
    const routes = new Router('/echo')
    routes.post('/').handler(async ctx => ctx.req.raw.text())
    const app = await ready(routes)

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ping'))
        controller.close()
      },
    })
    const res = await app.request('/echo', {
      method: 'POST',
      body,
      headers: { 'content-length': '4', 'content-type': 'text/plain' },
      duplex: 'half',
    } as RequestInit)

    expect(await res.text()).toBe('ping')
  })

  it('refuses a body longer than its Content-Length, as fetch does', async () => {
    const routes = new Router('/echo')
    routes.post('/').handler(async ctx => ctx.req.raw.text())
    const app = await ready(routes)

    const call = app.request('/echo', { method: 'POST', body: 'abcd', headers: { 'content-length': '2' } })

    await expect(call).rejects.toThrow(TypeError)
    await expect(call).rejects.toThrow('Cannot send the request body: it is longer than its Content-Length of 2 bytes')
  })

  it("rejects with an abort's reason while the handler runs, and aborts ctx.signal", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<boolean>()
    const routes = new Router('/hold')
    routes.get('/').handler(async ctx => {
      started.resolve()
      await once(ctx.signal, 'abort')
      aborted.resolve(ctx.signal.aborted)
      return 'late'
    })
    const app = await ready(routes)

    const controller = new AbortController()
    const reason = new Error('the caller gave up')
    const call = app.request('/hold', { signal: controller.signal })
    await started.promise
    controller.abort(reason)

    await expect(call).rejects.toBe(reason)
    expect(await aborted.promise).toBe(true)
  })

  it('lets close() resolve while an answer streams unread', async () => {
    const routes = new Router('/endless')
    routes.get('/').handler(
      () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024))
          },
        }),
    )
    const app = await ready(routes)

    const res = await app.request('/endless')
    expect(res.status).toBe(200)

    await app.close()
  })

  it('answers 503 while close() drains a request in flight', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const routes = new Router('/a')
    routes.get('/hold').handler(async () => {
      started.resolve()
      await release.promise
      return 'held'
    })
    routes.get('/hi').handler(() => 'hi')
    const app = await ready(routes)

    const held = app.request('/a/hold')
    await started.promise
    const closed = app.close()

    // Closing begins a moment after close() is called: wait on the answer itself.
    let res!: Response
    await vi.waitFor(async () => {
      res = await app.request('/a/hi')
      expect(res.status).toBe(503)
    })
    expect(((await res.json()) as { code: string }).code).toBe('ERR_HTTP_SERVICE_UNAVAILABLE')

    release.resolve()
    expect(await (await held).text()).toBe('held')
    await closed
  })
})
