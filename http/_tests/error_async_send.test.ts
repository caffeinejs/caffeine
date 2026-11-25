import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { Catch, Controller, Get, HTTPPlugin, type HTTPSetupContext, type IContext } from '../index.js'
import { node } from '../platform/node.testkit.js'

/** An asynchronous `onSend` hook, counting each run through `onRun` and holding the send for `ms`. */
class SlowSend extends HTTPPlugin {
  override readonly name = 'slow-send'

  constructor(
    private readonly onRun: () => void,
    private readonly ms: number,
  ) {
    super()
  }

  register({ server }: HTTPSetupContext): void {
    server.hook('onSend', async (_ctx, payload) => {
      this.onRun()
      await sleep(this.ms)
      return payload
    })
  }
}

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

    let runs = 0

    try {
      const app = createWebApplication({ adapter: node() }).with(() => new SlowSend(() => runs++, 1))
      close = () => app.close()
      await app.bootstrap()

      const first = app.request('/err-async-send/boom')
      const second = app.request('/err-async-send/boom')
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
    // One send per request: a second would have run the hook again.
    expect(runs).toBe(2)
  })

  // The other way an error is answered: a `@Catch` handler that redirects and hands nothing back. The send is

  // the context's, so the runner must wait on it rather than read the handler's `undefined` as one of its own.
  it('leaves the response to a @Catch handler that answered from the context', async () => {
    @Controller('/err-async-redirect')
    class RedirectingController {
      @Get('/boom')
      async boom(): Promise<never> {
        await sleep(1)
        throw new Error('boom')
      }

      @Catch(Error)
      async onError(ctx: IContext): Promise<void> {
        ctx.redirect('/oops', 303)
      }
    }
    void [RedirectingController]

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    let runs = 0

    try {
      const app = createWebApplication({ adapter: node() }).with(() => new SlowSend(() => runs++, 20))
      close = () => app.close()
      await app.bootstrap()

      const res = await app.request('/err-async-redirect/boom')

      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/oops')

      // Long enough for a second send, were there one, to fail and be reported.
      await sleep(50)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
    expect(runs).toBe(1)
  })
})
