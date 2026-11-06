import { once } from 'node:events'

import { afterEach, describe, expect, it } from 'vitest'

import { $p } from '../../core/routing/picker.js'
import { Args, Controller, Post, Router, type IContext, type WebApplication } from '../../index.js'
import { createWebApplication } from './index.js'

/**
 * `ctx.signal` is the request's own: it aborts when the client leaves before the answer is out, and on a timed route
 * when the handler outlives its timeout. Every test runs over a socket, since only there does Node close a request as
 * soon as its body has been read, which is not the client leaving.
 */

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function listen(build: (app: WebApplication) => WebApplication = a => a): Promise<string> {
  app = build(createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } })) as WebApplication)
  const { address } = await app.run()
  return address.origin
}

const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' } as const

// Resolves once Node has closed the raw request, which it does as soon as the body has been read.
async function requestClosed(ctx: IContext): Promise<void> {
  const raw = ctx.platform.request.raw
  if (!raw.closed) {
    await once(raw, 'close')
  }
}

describe('the request signal', () => {
  // A handler that passes the signal on, to a call of its own, must not see that call cancelled before it starts.
  it('stays open while the handler runs, once the body of a POST has been read', async () => {
    const router = new Router('/read')
    router.post('/').handler(async ctx => {
      // Read first, as a handler that hands it on does: a signal first read after the close never heard it.
      const signal = ctx.signal
      await requestClosed(ctx)
      return { aborted: signal.aborted }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)

    const res = await fetch(`${origin}/read`, json)

    expect(await res.json()).toEqual({ aborted: false })
  })

  it('is the same open signal through $p.signal(), on a POST with a body', async () => {
    @Controller('/picked')
    class PickedController {
      @Post('/')
      @Args([$p.signal(), $p.context()])
      async picked(signal: AbortSignal, ctx: IContext) {
        await requestClosed(ctx)
        return { aborted: signal.aborted, same: signal === ctx.signal }
      }
    }
    void [PickedController]
    const origin = await listen()

    const res = await fetch(`${origin}/picked`, json)

    expect(await res.json()).toEqual({ aborted: false, same: true })
  })

  // What lets a handler stop the work it started for a client that is gone.
  it('aborts when the client leaves while the handler runs', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/left')
    router.post('/').handler(async ctx => {
      const signal = ctx.signal
      await requestClosed(ctx)
      started.resolve(signal)
      await held.promise
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)
    const client = new AbortController()

    try {
      const call = fetch(`${origin}/left`, { ...json, signal: client.signal })
      const signal = await started.promise
      expect(signal.aborted).toBe(false)

      const aborted = once(signal, 'abort')
      client.abort()

      await expect(call).rejects.toThrow()
      await aborted
      expect(signal.aborted).toBe(true)
    } finally {
      held.resolve()
    }
  })

  // Work a handler started that outlives its answer, such as a notice sent after it, belongs to no client that left.
  it('never aborts on a request answered in full', async () => {
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/answered')
    router.post('/').handler(async ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      await requestClosed(ctx)
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)

    const res = await fetch(`${origin}/answered`, json)
    expect(await res.json()).toEqual({ ok: true })

    const signal = await closed.promise
    expect(signal.aborted).toBe(false)
  })

  // `app.request(...)` answers through no socket, and its response closes before it reports itself finished.
  it('never aborts on a request answered in full in-process', async () => {
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/answered-in-process')
    router.post('/').handler(ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      return { ok: true }
    })
    app = createWebApplication().mount(router) as WebApplication
    await app.bootstrap()

    const res = await app.request('/answered-in-process', json)
    expect(await res.json()).toEqual({ ok: true })

    const signal = await closed.promise
    expect(signal.aborted).toBe(false)
  })

  it("aborts with the handler timeout's reason on a timed route", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/timed')
    router.get('/').handler(async ctx => {
      started.resolve(ctx.signal)
      await held.promise
      return { late: true }
    })
    const origin = await listen(
      a => a.server(() => ({ factory: { handlerTimeout: 30 } })).mount(router) as WebApplication,
    )

    try {
      const res = await fetch(`${origin}/timed`)
      const signal = await started.promise

      expect(res.status).toBe(503)
      expect(signal.aborted).toBe(true)
      expect((signal.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
    } finally {
      held.resolve()
    }
  })
})
