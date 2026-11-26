import { setImmediate } from 'node:timers/promises'

import { ErrApplicationClosed } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { ErrWaitUntilClosed, type ServerContext } from '../../context.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { Router } from '../routing/programmatic/programmatic.js'

// Any fetch application: the route types each carries are not under test here.
type FetchApp = WebApplication<any, any, any>

let app: FetchApp | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

describe('the fetch application', () => {
  it.each<[string, (app: FetchApp) => unknown, string]>([
    [
      'a factory returning a function, at the root',
      a => a.with((() => async () => undefined) as never),
      'Cannot install a server plugin',
    ],
    ['a factory that returns nothing', a => a.with((() => undefined) as never), 'only an HTTPPlugin can be installed'],
    [
      'a factory returning a function, on a router',
      a =>
        a.mount(
          new Router('/r')
            .with((() => async () => undefined) as never)
            .get('/')
            .handler(() => 'r'),
        ),
      'Cannot install a server plugin',
    ],
  ])('refuses %s at start-up', async (_what, configure, message) => {
    app = createWebApplication()
    configure(app)

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow(message)
  })

  it('runs a context middleware, from the application and from a plugin', async () => {
    app = createWebApplication()
      .use((ctx, next) => {
        ctx.header('x-app', '1')
        next()
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register(context: Parameters<HTTPPlugin['register']>[0]): void {
              context.server.use((ctx, next) => {
                ctx.header('x-plugin', '1')
                next()
              })
            }
          })(),
      )
      .mount(new Router('/x').get('/').handler(() => 'x'))
    await app.bootstrap()

    const res = await app.fetch(new Request('http://localhost/x'))

    expect(res.headers.get('x-app')).toBe('1')
    expect(res.headers.get('x-plugin')).toBe('1')
    expect(await res.text()).toBe('x')
  })

  it('accepts an HTTPPlugin that mounts a router', async () => {
    app = createWebApplication().with(
      () =>
        new (class extends HTTPPlugin {
          register(context: Parameters<HTTPPlugin['register']>[0]): void {
            context.server.mount(new Router('/mounted').get('/').handler(() => 'mounted'))
          }
        })(),
    )
    await app.bootstrap()

    const res = await app.fetch(new Request('http://localhost/mounted'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mounted')
  })

  it("serves a listener's routes through the listener's fetch", async () => {
    app = createWebApplication().listener('admin', l => l.mount(new Router('/jobs').get('/').handler(() => 'jobs')))
    await app.bootstrap()

    const res = await app.listeners.get('admin')!.fetch(new Request('http://localhost/jobs'))

    expect(await res.text()).toBe('jobs')
    expect((await app.fetch(new Request('http://localhost/jobs'))).status).toBe(404)
  })

  // request() is the in-process call a test makes; a closed application refuses it rather than answering 503 for good.
  it('rejects request() with ErrApplicationClosed once close() has torn the server down', async () => {
    app = createWebApplication().mount(new Router('/x').get('/').handler(() => 'x'))
    await app.run()
    expect((await app.request('/x')).status).toBe(200)

    await app.close()

    await expect(app.request('/x')).rejects.toBeInstanceOf(ErrApplicationClosed)
  })
})

describe('Fetch host background work', () => {
  it('keeps a synchronous response and the original request and runtime arguments', async () => {
    const request = new Request('http://example.test/peer')
    const env = {}
    const execution = {}
    const resolve = vi.fn((_runtime: readonly unknown[]) => undefined)
    const seen = vi.fn()
    const router = new Router('/')
    router.get('/plain').handler(() => 'ok')
    router.get('/peer').handler(ctx => {
      seen(ctx.req.raw, ctx.platform, ctx.server.remoteAddress, 'waitUntil' in ctx.server)
      return 'peer'
    })
    app = createWebApplication()
      .server(() => ({ fetchWaitUntil: resolve }))
      .mount(router)
    await app.bootstrap()

    const plain = app.fetch(new Request('http://example.test/plain'), env, execution)
    expect(plain).toBeInstanceOf(Response)
    expect(await (await plain).text()).toBe('ok')
    expect(resolve).not.toHaveBeenCalled()

    const peer = app.fetch(request, env, execution)
    expect(peer).toBeInstanceOf(Response)
    expect(await (await peer).text()).toBe('peer')
    expect(resolve).toHaveBeenCalledTimes(1)
    const [runtime] = resolve.mock.calls[0]!
    expect(runtime).toHaveLength(2)
    expect(runtime[0]).toBe(env)
    expect(runtime[1]).toBe(execution)
    expect(seen).toHaveBeenCalledExactlyOnceWith(request, { name: 'fetch', runtime }, undefined, false)
    const [raw, platform] = seen.mock.calls[0]!
    expect(raw).toBe(request)
    expect(platform.runtime[0]).toBe(env)
    expect(platform.runtime[1]).toBe(execution)
  })

  it('passes overlapping invocations only to their own bound receiver', async () => {
    class Execution {
      readonly registrations: Promise<unknown>[] = []
      waitUntil(work: Promise<unknown>): void {
        this.registrations.push(work)
      }
    }
    const resolve = vi.fn(([, execution]: readonly unknown[]) =>
      execution instanceof Execution ? execution.waitUntil.bind(execution) : undefined,
    )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const router = new Router('/')
    router.get('/first').handler(async ctx => {
      const view = ctx.server
      entered.resolve()
      await release.promise
      view.waitUntil!(Promise.resolve())
      return 'first'
    })
    router.get('/second').handler(ctx => {
      ctx.server.waitUntil!(Promise.resolve())
      return 'second'
    })
    app = createWebApplication()
      .server(() => ({ fetchWaitUntil: resolve }))
      .mount(router)
    await app.bootstrap()

    const first = new Execution()
    const second = new Execution()
    try {
      const pending = app.fetch(new Request('http://example.test/first'), {}, first)
      await entered.promise
      const response = app.fetch(new Request('http://example.test/second'), {}, second)
      expect(second.registrations).toHaveLength(1)
      expect(first.registrations).toHaveLength(0)
      expect(await (await response).text()).toBe('second')

      release.resolve()
      expect(await (await pending).text()).toBe('first')
      expect(first.registrations).toHaveLength(1)
      expect(second.registrations).toHaveLength(1)
      expect(resolve).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
    }
  })

  it.each([true, false])(
    'ignores a lookalike host in an unrelated runtime argument (configured: %s)',
    async configured => {
      const decoy = { waitUntil: vi.fn() }
      const resolve = vi.fn(([, execution]: readonly unknown[]) =>
        execution === decoy ? decoy.waitUntil.bind(decoy) : undefined,
      )
      app = createWebApplication()
        .server(() => (configured ? { fetchWaitUntil: resolve } : {}))
        .mount(new Router('/').get('/').handler(ctx => String('waitUntil' in ctx.server)))
      await app.bootstrap()

      const extras = configured ? [decoy] : [{}, decoy]
      expect(await (await app.fetch(new Request('http://example.test/'), ...extras)).text()).toBe('false')
      expect(resolve).toHaveBeenCalledTimes(configured ? 1 : 0)
      expect(decoy.waitUntil).not.toHaveBeenCalled()
    },
  )

  it.each(['error', 'undefined', 'invalid return', 'rejected promise'] as const)(
    'remembers a failed resolver (%s) for the request',
    async kind => {
      const failure = kind === 'error' ? new Error('resolver failed') : undefined
      let calls = 0
      const resolve = () => {
        calls++
        if (kind === 'rejected promise') {
          return Promise.reject(new Error('asynchronous resolver failed')) as never
        }
        if (kind === 'invalid return') {
          return 42 as never
        }
        throw failure
      }
      const failures: unknown[] = []
      app = createWebApplication()
        .server(() => ({ fetchWaitUntil: resolve }))
        .mount(
          new Router('/').get('/').handler(ctx => {
            for (let i = 0; i < 2; i++) {
              try {
                void ctx.server
              } catch (err) {
                failures.push(err)
              }
            }
            return 'ok'
          }),
        )
      await app.bootstrap()

      expect(await (await app.fetch(new Request('http://example.test/'))).text()).toBe('ok')
      expect(calls).toBe(1)
      expect(failures).toHaveLength(2)
      expect(failures[1]).toBe(failures[0])
      if (kind === 'invalid return' || kind === 'rejected promise') {
        expect(failures[0]).toBeInstanceOf(ErrConfiguration)
        const received = kind === 'rejected promise' ? 'a promise' : 'a number'
        expect(failures[0]).toMatchObject({
          code: 'ERR_CONFIGURATION',
          message: expect.stringContaining(
            `Cannot resolve fetchWaitUntil: expected a function or undefined, received ${received}`,
          ),
        })
      } else {
        expect(failures[0]).toBe(failure)
      }
    },
  )

  it('keeps injected requests on the local lifetime when Fetch has a host resolver', async () => {
    const resolve = vi.fn(() => undefined)
    const held = Promise.withResolvers<void>()
    const onClose = vi.fn()
    app = createWebApplication()
      .shutdown(s => s.drainDelay(0))
      .server(() => ({ fetchWaitUntil: resolve }))
      .hook('onClose', onClose)
      .mount(
        new Router('/').post('/').handler(ctx => {
          ctx.server.waitUntil!(held.promise)
          return ctx.req.header('x-label')
        }),
      )
    await app.bootstrap()

    try {
      const response = await app.request('/', { method: 'POST', headers: { 'x-label': 'injected' } })
      expect(await response.text()).toBe('injected')
      expect(resolve).not.toHaveBeenCalled()
      const closing = app.close()
      await setImmediate()
      expect(onClose).not.toHaveBeenCalled()
      held.resolve()
      await closing
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
    }
  })

  it('drains accepted work after the host starts close and fulfills its registration', async () => {
    const error = vi.fn()
    const closed = vi.fn()
    const held = Promise.withResolvers<void>()
    const host = vi.fn((_work: Promise<unknown>) => {
      void app!.close().then(closed)
      return Promise.resolve()
    })
    let waitUntil: ServerContext['waitUntil']
    app = createWebApplication()
      .shutdown(s => s.drainDelay(0))
      .logger(b => b.use({ ...newNoopLogger(), error }))
      .server(() => ({ fetchWaitUntil: () => host }))
      .mount(
        new Router('/').get('/').handler(ctx => {
          waitUntil = ctx.server.waitUntil!
          waitUntil(held.promise)
          return ctx.req.id
        }),
      )
    await app.bootstrap()

    try {
      const response = app.fetch(new Request('http://example.test/'))
      expect(host).toHaveBeenCalledTimes(1)
      const [observed] = host.mock.calls[0]!
      const logsAtFulfillment = observed.then(() => error.mock.calls.slice())
      const reqId = await (await response).text()
      const late = new Error('late task failed')
      expect(() => waitUntil!(Promise.reject(late))).toThrow(ErrWaitUntilClosed)
      expect(host).toHaveBeenCalledTimes(1)
      await setImmediate()
      expect(closed).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledExactlyOnceWith({ reqId, err: late }, 'Background work failed')

      const failure = new Error('accepted task failed')
      held.reject(failure)
      expect(await logsAtFulfillment).toEqual([
        [{ reqId, err: late }, 'Background work failed'],
        [{ reqId, err: failure }, 'Background work failed'],
      ])
      await app.close()
      expect(closed).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
    }
  })

  it('completes shutdown on async host refusal while the registered task is still pending', async () => {
    const task = Promise.withResolvers<void>()
    const registration = Promise.withResolvers<void>()
    const error = vi.fn()
    const refusal = new Error('host refused registration')
    app = createWebApplication()
      .shutdown(s => s.drainDelay(0))
      .logger(b => b.use({ ...newNoopLogger(), error }))
      .server(() => ({
        fetchWaitUntil: () => async () => {
          await registration.promise
          throw refusal
        },
      }))
      .mount(
        new Router('/').get('/').handler(ctx => {
          ctx.server.waitUntil!(task.promise)
          return ctx.req.id
        }),
      )
    await app.bootstrap()

    try {
      const response = await app.fetch(new Request('http://example.test/'))
      expect(response.status).toBe(200)
      const reqId = await response.text()
      const closed = vi.fn()
      const closing = app.close().then(closed)
      await setImmediate()
      expect(closed).not.toHaveBeenCalled()

      registration.resolve()
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
      await closing
      expect(error).toHaveBeenCalledExactlyOnceWith(
        { reqId, err: refusal },
        'Host rejected background work registration',
      )

      const failure = new Error('task failed after shutdown')
      task.reject(failure)
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith({ reqId, err: failure }, 'Background work failed'))
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      registration.resolve()
      task.resolve()
    }
  })

  it('rolls back only the refused registrations and still observes their rejections', async () => {
    const error = vi.fn()
    const onClose = vi.fn()
    const earlier = Promise.withResolvers<void>()
    const later = Promise.withResolvers<void>()
    const declined = Promise.withResolvers<void>()
    const afterClose = Promise.withResolvers<void>()
    const refusal = new Error('host declined')
    const host = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw refusal
      })
      .mockImplementationOnce(() => {
        throw refusal
      })
    const failures: unknown[] = []
    app = createWebApplication()
      .shutdown(s => s.drainDelay(0))
      .logger(b => b.use({ ...newNoopLogger(), error }))
      .server(() => ({ fetchWaitUntil: () => host }))
      .hook('onClose', onClose)
      .mount(
        new Router('/').get('/').handler(ctx => {
          const register = ctx.server.waitUntil!
          register(earlier.promise)
          for (const work of [declined.promise, afterClose.promise]) {
            try {
              register(work)
            } catch (err) {
              failures.push(err)
            }
          }
          register(later.promise)
          return ctx.req.id
        }),
      )
    await app.bootstrap()

    try {
      const response = app.fetch(new Request('http://example.test/'))
      expect(host).toHaveBeenCalledTimes(4)
      expect(failures).toHaveLength(2)
      expect(failures[0]).toBe(refusal)
      expect(failures[1]).toBe(refusal)
      const reqId = await (await response).text()
      const closing = app.close()
      earlier.resolve()
      const failure = new Error('declined task failed')
      declined.reject(failure)
      await setImmediate()
      expect(onClose).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledExactlyOnceWith({ reqId, err: failure }, 'Background work failed')

      later.resolve()
      await setImmediate()
      expect(onClose).toHaveBeenCalledTimes(1)
      await closing
      const lateFailure = new Error('task failed after close')
      afterClose.reject(lateFailure)
      await setImmediate()
      expect(error).toHaveBeenCalledWith({ reqId, err: lateFailure }, 'Background work failed')
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      earlier.resolve()
      later.resolve()
      declined.resolve()
      afterClose.resolve()
    }
  })
})

describe("a router plugin's path-scoped middleware", () => {
  // The middleware covers every request the router sends to the router's route, or a guard there could be skipped.
  const nine = Array.from({ length: 9 }, (_, i) => `/:p${i}`).join('')

  it.each([
    ['/tenants/:id', undefined, {}, '/tenants//jobs'],
    [nine, undefined, {}, '/1/2/3/4/5/6/7/8/9/jobs'],
  ])('under %j prefixed %j with %j runs for %s', async (path, prefix, router, url) => {
    const a = createWebApplication()
      .server(() => ({ router }))
      .mount(
        new Router(path)
          .extend((group: { prefix(prefix: string): unknown }) => {
            if (prefix !== undefined) {
              group.prefix(prefix)
            }
          })
          .with(
            () =>
              new (class extends HTTPPlugin {
                register({ server }: HTTPSetupContext): void {
                  server.use('/jobs', (ctx, next) => {
                    ctx.header('x-guard', 'ran')
                    return next()
                  })
                }
              })(),
          )
          .get('/jobs')
          .handler(() => 'jobs'),
      )
    app = a
    await a.bootstrap()

    const res = await a.request(url)

    expect([res.status, res.headers.get('x-guard')]).toEqual([200, 'ran'])
  })
})
