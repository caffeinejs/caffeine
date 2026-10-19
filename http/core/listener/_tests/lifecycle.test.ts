import { createServer } from 'node:net'

import { ErrApplicationNotReady } from '@caffeinejs/application'
import { ErrShutdownTimeout } from '@caffeinejs/application/shutdown'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Listener, bindTo, type WebApplication } from '../../../index.js'
import { createWebApplication, healthProbes, newRouter } from '../../../platform/fastify/index.js'

/**
 * A listener's lifecycle follows the application's own server: it starts after it — the first listen to
 * complete is the one Watt takes over — and closes after it, so probes and metrics answer while the application
 * drains. A binding no server answers to stops the application at start-up rather than landing anywhere.
 */

const listener = { host: '127.0.0.1', port: 0 }

const jobs = () =>
  newRouter('/jobs')
    .extend(bindTo('admin'))
    .get('/', () => ({ jobs: true }))

describe('the lifecycle of a listener', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    // A test that failed mid-drain left the drain timer fake and pending: run it, or the close below joins a
    // shutdown that never ends.
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync()
    }
    vi.useRealTimers()

    await app?.close().catch(() => undefined)
    app = undefined
  })

  it("listens after the application's own server, and closes after it", async () => {
    const events: string[] = []
    const recording = (server: string) => (instance: FastifyInstance) => {
      instance.addHook('onListen', done => {
        events.push(`${server} listening`)
        done()
      })
      instance.addHook('onClose', (_instance, done) => {
        events.push(`${server} closed`)
        done()
      })
    }

    app = createWebApplication()
      .install(
        Listener('admin', l =>
          l
            .server(() => ({ listener }))
            .with(() => fp(async (instance: FastifyInstance) => recording('admin')(instance))),
        ),
      )
      .server(() => ({ listener }))
      .serverCallback((_context, instance) => recording('main')(instance))
      .mount(jobs()) as WebApplication

    await app.run()
    await app.close()
    app = undefined

    expect(events).toEqual(['main listening', 'admin listening', 'main closed', 'admin closed'])
  })

  it("keeps a listener answering while the application's own server drains, its readiness turning 503", async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener })).with(healthProbes())))
      .shutdown(s => s.drainDelay(300)) as WebApplication

    await app.run()
    const admin = app.listeners.get('admin')!
    const origin = admin.address!.origin

    expect((await fetch(`${origin}/readyz`)).status).toBe(200)

    // Only the drain timer is faked, so the delay cannot end before the checks below have run. The fetch above
    // built undici's clock on real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = app.close()

    // No await in between: the flip has to be visible on the very next poll, over the listener's own port.
    expect((await fetch(`${origin}/readyz`)).status).toBe(503)
    expect((await fetch(`${origin}/livez`)).status).toBe(200)
    expect(admin.instance.server.listening).toBe(true)

    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    await closing
    expect(admin.instance.server.listening).toBe(false)
    app = undefined
  })

  it('cuts an overrunning request on a listener once the shutdown budget runs out', async () => {
    let started!: () => void
    const inFlight = new Promise<void>(resolve => (started = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))

    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener }))))
      .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
      .mount(
        newRouter('/slow')
          .extend(bindTo('admin'))
          .get('/', async () => {
            started()
            await held
            return { ok: true }
          }),
      ) as WebApplication

    await app.run()
    const admin = app.listeners.get('admin')!
    const request = fetch(`${admin.address!.origin}/slow`).catch((error: unknown) => error)
    await inFlight

    const error = await app.close().catch((error: unknown) => error)

    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect(admin.instance.server.listening).toBe(false)
    expect(await request).toBeInstanceOf(Error)

    release()
    app = undefined
  })

  it('refuses a router bound to a name no server has, naming the router and the servers there are', async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener }))))
      .mount(
        newRouter('/jobs')
          .extend(bindTo('nowhere'))
          .get('/', () => ({})),
      ) as WebApplication

    const error = await app.bootstrap().catch((error: unknown) => error)

    expect(error).toMatchObject({ code: 'ERR_CONFIGURATION' })
    expect((error as Error).message).toMatch(
      /^Cannot serve router "Jobs": it is bound to "nowhere", and no installed server has that name/,
    )
    expect((error as Error).message).toContain(`.install(Listener('nowhere', ...))`)
    expect((error as Error).message).toContain('"admin"')
  })

  it('refuses a router bound to a name when no listener is installed, offering only to install one', async () => {
    app = createWebApplication().mount(
      newRouter('/jobs')
        .extend(bindTo('nowhere'))
        .get('/', () => ({})),
    ) as WebApplication

    const error = await app.bootstrap().catch((error: unknown) => error)

    expect((error as Error).message).toContain(`.install(Listener('nowhere', ...))`)
    expect((error as Error).message).not.toContain('Or bind to an installed server')
  })

  // A server that cannot close is reported, and the rest are closed all the same.
  describe('a server that cannot close', () => {
    /** A plugin whose server fails to close with `failure`, once it has stopped listening. */
    const failingToClose = (failure: Error) => () =>
      fp(async (instance: FastifyInstance) => {
        instance.addHook('onClose', (_instance, done) => done(failure))
      })

    it('reports a listener that cannot close, the others closed all the same', async () => {
      const failure = new Error('admin cannot close')

      app = createWebApplication()
        .install(Listener('admin', l => l.server(() => ({ listener })).with(failingToClose(failure))))
        .server(() => ({ listener }))
        .mount(jobs()) as WebApplication

      await app.run()
      const servers = [app.instance, app.listeners.get('admin')!.instance]

      const error = await app.close().catch((error: unknown) => error)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toHaveLength(1)
      expect((error as AggregateError).errors[0]).toBe(failure)
      expect(servers.map(instance => instance.server.listening)).toEqual([false, false])
      app = undefined
    })

    it("reports every server that cannot close together, the application's own first", async () => {
      const ownFailure = new Error('own cannot close')
      const adminFailure = new Error('admin cannot close')

      app = createWebApplication()
        .install(Listener('admin', l => l.server(() => ({ listener })).with(failingToClose(adminFailure))))
        .server(() => ({ listener }))
        .with(failingToClose(ownFailure))
        .mount(jobs()) as WebApplication

      await app.run()

      const error = await app.close().catch((error: unknown) => error)
      const closing = (error as AggregateError).errors[0] as AggregateError

      expect(closing).toBeInstanceOf(AggregateError)
      expect(closing.message).toBe('Cannot close every server')
      expect(closing.errors).toHaveLength(2)
      expect(closing.errors[0]).toBe(ownFailure)
      expect(closing.errors[1]).toBe(adminFailure)
      app = undefined
    })
  })

  it('has no listeners to reach before bootstrap, and none when none was installed', async () => {
    app = createWebApplication()

    expect(() => app!.listeners).toThrow(ErrApplicationNotReady)

    await app.bootstrap()

    expect(app.listeners.size).toBe(0)
  })

  it('starts each listener on its own settings, whatever run() is given', async () => {
    const free = await new Promise<number>(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number }
        probe.close(() => resolve(port))
      })
    })

    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener }))))
      .mount(jobs()) as WebApplication

    // Handed to the listener as well, the port would be taken twice and run() would reject.
    await app.run({ host: '127.0.0.1', port: free })

    expect(app.address!.port).toBe(free)
    expect(app.listeners.get('admin')!.address!.port).not.toBe(free)
  })

  it('answers an injected request on a listener, with nothing listening', async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener }))))
      .mount(jobs()) as WebApplication

    await app.bootstrap()
    const admin = app.listeners.get('admin')!

    expect(admin.address).toBeUndefined()
    expect(await (await admin.fetch('/jobs')).json()).toEqual({ jobs: true })
    expect((await app.fetch('/jobs')).status).toBe(404)
  })
})
