import { setTimeout as sleep } from 'node:timers/promises'

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'

import { Responder, createWebApplication, newRouter, type Context } from '../index.js'

/**
 * A handler that answered the request itself and then returned — the shape of a sign-out: `ctx.redirect(...)`,
 * and nothing else to hand back. The adapter sends an empty response for a handler that returns `undefined`,
 * and doing that here answers twice: `FST_ERR_REP_ALREADY_SENT` in the log for a response already out, and
 * headers written over headers while an `onSend` hook that awaits still holds the first send open.
 */

interface LogEntry {
  level?: number
  msg?: string
  err?: { code?: string }
}

/** Fastify's own logger, writing every line into `logged`. Named in the factory settings, so it is the server's. */
function pinoTo(logged: LogEntry[], level = 'warn') {
  return { level, stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } }
}

function alreadySent(logged: LogEntry[]): LogEntry[] {
  return logged.filter(entry => entry.err?.code === 'FST_ERR_REP_ALREADY_SENT')
}

/** An `onSend` hook that awaits, the position `@Compress` and `@caffeinejs/caching` occupy. */
function slowSend(runs: { n: number }): FastifyPluginAsync {
  return async instance => {
    instance.addHook('onSend', async (_request, _reply, payload) => {
      runs.n++
      await sleep(20)
      return payload
    })
  }
}

/** Fails the assertion when a second send reported itself as an unhandled rejection. */
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

describe('a handler that answered the request itself', () => {
  it('redirects once from a synchronous handler', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .mount(newRouter('/sync').get('/', ctx => void ctx.redirect('/foo')))
    await app.ready()

    const res = await app.fetch('/sync')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/foo')
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('redirects once from an asynchronous handler', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .mount(
        newRouter('/async').get('/', async ctx => {
          await sleep(1)
          ctx.redirect('/', 303)
        }),
      )
    await app.ready()

    const res = await app.fetch('/async', { method: 'GET' })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(await res.text()).toBe('')
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('answers once with a status shorthand', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .mount(
        newRouter('/gone').get('/', async ctx => {
          await sleep(1)
          ctx.notFound()
        }),
      )
    await app.ready()

    const res = await app.fetch('/gone')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'ERR_HTTP_NOT_FOUND' })
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('sends a redirect the handler set up and left unsent', async () => {
    const app = createWebApplication().mount(
      newRouter('/prepared').get('/', ctx => void ctx.status(302).header('location', '/x')),
    )
    await app.ready()

    const res = await app.fetch('/prepared')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/x')

    await app.close()
  })

  it('still sends an empty response when the handler answered nothing', async () => {
    const app = createWebApplication().mount(
      newRouter('/quiet')
        .get('/sync', () => {})
        .get('/async', async () => {
          await sleep(1)
        })
        .get('/value', () => ({ ok: true })),
    )
    await app.ready()

    const sync = await app.fetch('/quiet/sync')
    expect(sync.status).toBe(200)
    expect(await sync.text()).toBe('')

    const async_ = await app.fetch('/quiet/async')
    expect(async_.status).toBe(200)
    expect(await async_.text()).toBe('')

    const value = await app.fetch('/quiet/value')
    expect(await value.json()).toEqual({ ok: true })

    await app.close()
  })
})

/**
 * `reply.sent` is `raw.writableEnded`, so it stays false for as long as a hook holds the first send open. A
 * second send started in that window is not the logged warning of a response already out: it runs the hook
 * chain again and writes headers over headers.
 */
describe('under an onSend hook that awaits', () => {
  it('runs the send hook once for an asynchronous handler that answered itself', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(
          newRouter('/held').get('/', async ctx => {
            await sleep(1)
            ctx.body({ ok: true })
          }),
        )
      await app.ready()

      const res = await app.fetch('/held')

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  it('runs the send hook once for a synchronous handler that answered itself', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(newRouter('/held-sync').get('/', ctx => void ctx.body({ ok: true })))
      await app.ready()

      const res = await app.fetch('/held-sync')

      expect(await res.json()).toEqual({ ok: true })

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  // The adapter's own send is the one in flight here: resolving the promise with `undefined` after starting it
  // is what Fastify reads as a request to send, and both of its guards are still false inside the hook.
  it('runs the send hook once for an asynchronous handler that answered nothing', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(
          newRouter('/held-empty').get('/', async () => {
            await sleep(1)
          }),
        )
      await app.ready()

      const res = await app.fetch('/held-empty')

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  // A value handed back after the context answered is not a second answer: Fastify sends any value a promise
  // resolves with, and any value a synchronous handler returns, with no check of its own.
  it('runs the send hook once for an asynchronous handler that answered itself and then returned a value', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(
          newRouter('/held-value').get('/', async ctx => {
            await sleep(1)
            ctx.redirect('/x', 303)
            return { late: true }
          }),
        )
      await app.ready()

      const res = await app.fetch('/held-value')

      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/x')
      expect(await res.text()).toBe('')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  it('runs the send hook once for a synchronous handler that answered itself and then returned a value', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(
          newRouter('/held-sync-value').get('/', ctx => {
            ctx.body('first')
            return 'second'
          }),
        )
      await app.ready()

      const res = await app.fetch('/held-sync-value')

      expect(await res.text()).toBe('first')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  it('does not run a Responder returned after the context answered', async () => {
    const runs = { n: 0 }
    let responded = false

    class Late extends Responder {
      respond(ctx: Context) {
        responded = true
        return ctx.body('second')
      }
    }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => fp(slowSend(runs), { name: 'slow-send' }))
        .mount(
          newRouter('/held-responder').get('/', async ctx => {
            await sleep(1)
            ctx.body('first')
            return new Late()
          }),
        )
      await app.ready()

      const res = await app.fetch('/held-responder')

      expect(await res.text()).toBe('first')

      await app.close()
    })

    expect(responded).toBe(false)
    expect(runs.n).toBe(1)
  })

  // What the flag adds, and why Fastify's own answer could not have been it.
  it('has answered the request the moment the context sent it', async () => {
    let seen: [boolean, boolean] | undefined
    const runs = { n: 0 }

    const app = createWebApplication()
      .with(() => fp(slowSend(runs), { name: 'slow-send' }))
      .mount(
        newRouter('/record').get('/', ctx => {
          ctx.body({ ok: true })
          seen = [ctx.sent, ctx.platform.reply.sent]
        }),
      )
    await app.ready()

    await app.fetch('/record')

    expect(seen).toEqual([true, false])

    await app.close()
  })
})
