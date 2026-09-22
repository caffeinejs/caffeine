import { setTimeout as sleep } from 'node:timers/promises'

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, createWebApplication } from '../index.js'

/**
 * The global error handler is asynchronous and, on the default path, sends the reply itself. An `onSend` hook
 * that is asynchronous too — a cache, a compressor — holds that first send open a while, and the runner must not
 * take the handler's resolution as a request to send again: the second send wrote headers over headers already
 * out, an unhandled rejection that ends the process. Two requests interleave the timing that one request hides.
 */
describe('the global error handler under an asynchronous onSend hook', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('sends the error response once, for concurrent failures on one route', async () => {
    let open!: () => void
    let entered = 0
    const opened = new Promise<void>(resolve => (open = resolve))

    @Controller('/err-async-send')
    class ThrowingController {
      @Get('/boom')
      async boom() {
        entered++
        await opened
        throw new Error('boom')
      }
    }
    void [ThrowingController]

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      const slowSend: FastifyPluginAsync = async instance => {
        instance.addHook('onSend', async (_request, _reply, payload) => {
          await sleep(1)
          return payload
        })
      }
      const app = createWebApplication().with(() => fp(slowSend, { name: 'slow-send' }))
      close = () => app.close()
      await app.ready()

      const first = app.fetch('/err-async-send/boom')
      const second = app.fetch('/err-async-send/boom')
      while (entered < 2) {
        await sleep(1)
      }
      open()

      const responses = await Promise.all([first, second])
      expect(responses.map(res => res.status)).toEqual([500, 500])

      // Long enough for a second send, were there one, to fail and be reported.
      await sleep(20)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  })
})
