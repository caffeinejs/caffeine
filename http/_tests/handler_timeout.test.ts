import { setTimeout as sleep } from 'node:timers/promises'

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, Router, createWebApplication } from '../index.js'

/**
 * Fastify answers a handler that outlives its timeout with a 503. An `onSend` hook that is asynchronous — a
 * compressor — holds that send open a while, and the handler resolving meanwhile must not be taken as a request
 * to send again: the second send wrote headers over headers already out, an unhandled rejection that ends the
 * process.
 */
describe('a handler that outlives its timeout', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  function slowSend(runs: { n: number }): FastifyPluginAsync {
    return async instance => {
      // Long enough that the slow handler, at 50ms, resolves while the 503 sent at 30ms is still held open here.
      // Only there: held open past the timeout, a fast route's own response would be answered 503 over by the
      // timer, which is the side of this Fastify has to fix.
      instance.addHook('onSend', async (request, _reply, payload) => {
        runs.n++
        if (request.url.endsWith('/slow')) {
          await sleep(60)
        }
        return payload
      })
    }
  }

  async function sendsOnce(run: () => Promise<void>): Promise<void> {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      await run()
      // Long enough for a second send, were there one, to fail and be reported.
      await sleep(50)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  }

  it('is answered 503 once on a server with a handlerTimeout, and a fast route still answers', async () => {
    @Controller('/timed')
    class TimedController {
      @Get('/slow')
      async slow() {
        await sleep(50)
        return 'late'
      }

      @Get('/fast')
      fast() {
        return 'ok'
      }
    }
    void [TimedController]

    const runs = { n: 0 }
    await sendsOnce(async () => {
      const app = createWebApplication()
        .server(() => ({ factory: { handlerTimeout: 30 } }))
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
      close = () => app.close()
      await app.ready()

      const slow = await app.fetch('/timed/slow')
      expect(slow.status).toBe(503)

      const fast = await app.fetch('/timed/fast')
      expect(fast.status).toBe(200)
      expect(await fast.text()).toBe('ok')
    })

    // The 503 and the fast response: nothing more went through the hook.
    expect(runs.n).toBe(2)
  })

  it('is answered 503 once on a route with its own timeout', async () => {
    const timed = new Router('/timed-route')
    timed
      .get('/slow')
      .timeout(30)
      .handler(async () => {
        await sleep(50)
        return 'late'
      })

    const runs = { n: 0 }
    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(timed)
      close = () => app.close()
      await app.ready()

      const slow = await app.fetch('/timed-route/slow')
      expect(slow.status).toBe(503)
    })

    expect(runs.n).toBe(1)
  })

  // A rejection is the late result too: taken to the error handler, it would send a 500 over the 503.
  it('is answered 503 once when the handler rejects after its timeout', async () => {
    const timed = new Router('/timed-reject')
    timed
      .get('/slow')
      .timeout(30)
      .handler(async () => {
        await sleep(50)
        throw new Error('late')
      })

    const runs = { n: 0 }
    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(timed)
      close = () => app.close()
      await app.ready()

      const slow = await app.fetch('/timed-reject/slow')
      expect(slow.status).toBe(503)
    })

    expect(runs.n).toBe(1)
  })
})
