import { setTimeout as sleep } from 'node:timers/promises'

import { newNoopLogger, type LogFn, type Logger } from '@caffeinejs/application/logger'
import { describe, expect, it } from 'vitest'

import { HTTPPlugin, Responder, type HTTPSetupContext, type IContext, Router } from '../index.js'
import { createWebApplication } from '../platform/node/index.js'

/**
 * A handler that answered the request itself and then returned — the shape of a sign-out: `ctx.redirect(...)`,
 * and nothing else to hand back. The application sends an empty response for a handler that returns `undefined`,
 * and doing that here answers twice: a warning in the log for a response already out, and
 * headers written over headers while an `onSend` hook that awaits still holds the first send open.
 */

interface LogEntry {
  level: number
  msg: string
  [field: string]: unknown
}

const LEVELS = { info: 30, warn: 40, error: 50 } as const

/** The application logger, recording each line at `threshold` or above into `logged`. */
function recordTo(logged: LogEntry[], threshold: keyof typeof LEVELS = 'info'): Logger {
  const at = (level: keyof typeof LEVELS): LogFn =>
    ((obj: unknown, msg?: string) => {
      if (LEVELS[level] < LEVELS[threshold]) {
        return
      }
      const [fields, text] = typeof obj === 'string' ? [{}, obj] : [obj as Record<string, unknown>, msg ?? '']
      logged.push({ ...fields, level: LEVELS[level], msg: text })
    }) as LogFn
  const logger: Logger = {
    ...newNoopLogger(),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger
}

const ALREADY_SENT = [
  'Cannot answer a request already answered: dropping the late answer',
  'Cannot change the response once it is sent: ignoring',
]

function alreadySent(logged: LogEntry[]): LogEntry[] {
  return logged.filter(entry => ALREADY_SENT.some(text => entry.msg.startsWith(text)))
}

/** An `onSend` hook that awaits, the position `@caffeinejs/caching` occupies. */
class SlowSend extends HTTPPlugin {
  override readonly name = 'slow-send'

  constructor(private readonly runs: { n: number }) {
    super()
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onSend', async (_ctx, payload) => {
      this.runs.n++
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
      .logger(b => b.use(recordTo(logged, 'warn')))
      .mount(new Router('/sync').get('/', ctx => void ctx.redirect('/foo')))
    await app.bootstrap()

    const res = await app.request('/sync')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/foo')
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('redirects once from an asynchronous handler', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .logger(b => b.use(recordTo(logged, 'warn')))
      .mount(
        new Router('/async').get('/', async ctx => {
          await sleep(1)
          ctx.redirect('/', 303)
        }),
      )
    await app.bootstrap()

    const res = await app.request('/async', { method: 'GET' })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(await res.text()).toBe('')
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('answers once with a status shorthand', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .logger(b => b.use(recordTo(logged, 'warn')))
      .mount(
        new Router('/gone').get('/', async ctx => {
          await sleep(1)
          ctx.notFound()
        }),
      )
    await app.bootstrap()

    const res = await app.request('/gone')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ status: 404, code: 'ERR_HTTP_NOT_FOUND' })
    expect(alreadySent(logged)).toEqual([])

    await app.close()
  })

  it('sends a redirect the handler set up and left unsent', async () => {
    const app = createWebApplication().mount(
      new Router('/prepared').get('/', ctx => void ctx.status(302).header('location', '/x')),
    )
    await app.bootstrap()

    const res = await app.request('/prepared')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/x')

    await app.close()
  })

  it('still sends an empty response when the handler answered nothing', async () => {
    const app = createWebApplication().mount(
      new Router('/quiet')
        .get('/sync', () => {})
        .get('/async', async () => {
          await sleep(1)
        })
        .get('/value', () => ({ ok: true })),
    )
    await app.bootstrap()

    const sync = await app.request('/quiet/sync')
    expect(sync.status).toBe(200)
    expect(await sync.text()).toBe('')

    const async_ = await app.request('/quiet/async')
    expect(async_.status).toBe(200)
    expect(await async_.text()).toBe('')

    const value = await app.request('/quiet/value')
    expect(await value.json()).toEqual({ ok: true })

    await app.close()
  })
})

/**
 * A second send started while a hook holds the first one open is not the logged warning of a response already
 * out: it would run the hook chain again and write headers over headers.
 */
describe('under an onSend hook that awaits', () => {
  it('runs the send hook once for an asynchronous handler that answered itself', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => new SlowSend(runs))
        .mount(
          new Router('/held').get('/', async ctx => {
            await sleep(1)
            ctx.body({ ok: true })
          }),
        )
      await app.bootstrap()

      const res = await app.request('/held')

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
        .with(() => new SlowSend(runs))
        .mount(new Router('/held-sync').get('/', ctx => void ctx.body({ ok: true })))
      await app.bootstrap()

      const res = await app.request('/held-sync')

      expect(await res.json()).toEqual({ ok: true })

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  // The application's own send is the one in flight here: resolving the promise with `undefined` after starting it
  // must not be read as a request to send.
  it('runs the send hook once for an asynchronous handler that answered nothing', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => new SlowSend(runs))
        .mount(
          new Router('/held-empty').get('/', async () => {
            await sleep(1)
          }),
        )
      await app.bootstrap()

      const res = await app.request('/held-empty')

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  // A value handed back after the context answered is not a second answer.
  it('runs the send hook once for an asynchronous handler that answered itself and then returned a value', async () => {
    const runs = { n: 0 }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => new SlowSend(runs))
        .mount(
          new Router('/held-value').get('/', async ctx => {
            await sleep(1)
            ctx.redirect('/x', 303)
            return { late: true }
          }),
        )
      await app.bootstrap()

      const res = await app.request('/held-value')

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
        .with(() => new SlowSend(runs))
        .mount(
          new Router('/held-sync-value').get('/', ctx => {
            ctx.body('first')
            return 'second'
          }),
        )
      await app.bootstrap()

      const res = await app.request('/held-sync-value')

      expect(await res.text()).toBe('first')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  it('does not run a Responder returned after the context answered', async () => {
    const runs = { n: 0 }
    let responded = false

    class Late extends Responder {
      respond(ctx: IContext) {
        responded = true
        return ctx.body('second')
      }
    }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => new SlowSend(runs))
        .mount(
          new Router('/held-responder').get('/', async ctx => {
            await sleep(1)
            ctx.body('first')
            return new Late()
          }),
        )
      await app.bootstrap()

      const res = await app.request('/held-responder')

      expect(await res.text()).toBe('first')

      await app.close()
    })

    expect(responded).toBe(false)
    expect(runs.n).toBe(1)
  })

  it('sends once when an asynchronous Responder answers through the context', async () => {
    const runs = { n: 0 }

    class Rendered extends Responder {
      async respond(ctx: IContext) {
        await Promise.resolve()
        ctx.body('rendered')
      }
    }

    await sendsOnce(async () => {
      const app = createWebApplication()
        .with(() => new SlowSend(runs))
        .mount(new Router('/held-async-responder').get('/', () => new Rendered()))
      await app.bootstrap()

      const res = await app.request('/held-async-responder')

      expect(await res.text()).toBe('rendered')

      await app.close()
    })

    expect(runs.n).toBe(1)
  })

  // The flag is true the moment the context sent the answer, while a hook still holds the send open.
  it('has answered the request the moment the context sent it', async () => {
    let seen: boolean | undefined
    const runs = { n: 0 }

    const app = createWebApplication()
      .with(() => new SlowSend(runs))
      .mount(
        new Router('/record').get('/', ctx => {
          ctx.body({ ok: true })
          seen = ctx.sent
        }),
      )
    await app.bootstrap()

    await app.request('/record')

    expect(seen).toBe(true)

    await app.close()
  })
})
