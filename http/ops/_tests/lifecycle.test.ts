import { createServer } from 'node:net'

import { ErrApplicationNotReady } from '@caffeinejs/std'
import { ErrShutdownTimeout } from '@caffeinejs/std/shutdown'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Ops, bindTo, createWebApplication, healthProbes, newRouter, type WebApplication } from '../../index.js'

/**
 * An ops server's lifecycle follows the application's own server: it listens after it — the first listen to
 * complete is the one Watt takes over — and closes after it, so probes and metrics answer while the application
 * drains. A binding no server answers to stops the application at start-up rather than landing anywhere.
 */

const listener = { host: '127.0.0.1', port: 0 }

const jobs = () =>
  newRouter('/jobs')
    .with(bindTo('admin'))
    .get('/', () => ({ jobs: true }))

describe('the lifecycle of an ops server', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
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
        Ops('admin', o =>
          o
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

  it("keeps an ops server answering while the application's own server drains, its readiness turning 503", async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener })).with(healthProbes())))
      .shutdown(s => s.drainDelay(300)) as WebApplication

    await app.run()
    const ops = app.ops.get('admin')!
    const origin = ops.address!.origin

    expect((await fetch(`${origin}/readyz`)).status).toBe(200)

    const closing = app.close()

    // No await in between: the flip has to be visible on the very next poll, over the ops server's own port.
    expect((await fetch(`${origin}/readyz`)).status).toBe(503)
    expect((await fetch(`${origin}/livez`)).status).toBe(200)
    expect(ops.instance.server.listening).toBe(true)

    await closing
    expect(ops.instance.server.listening).toBe(false)
    app = undefined
  })

  it('cuts an overrunning ops request once the shutdown budget runs out', async () => {
    let started!: () => void
    const inFlight = new Promise<void>(resolve => (started = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))

    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
      .mount(
        newRouter('/slow')
          .with(bindTo('admin'))
          .get('/', async () => {
            started()
            await held
            return { ok: true }
          }),
      ) as WebApplication

    await app.run()
    const ops = app.ops.get('admin')!
    const request = fetch(`${ops.address!.origin}/slow`).catch((error: unknown) => error)
    await inFlight

    const error = await app.close().catch((error: unknown) => error)

    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect(ops.instance.server.listening).toBe(false)
    expect(await request).toBeInstanceOf(Error)

    release()
    app = undefined
  })

  it('refuses a router bound to a name no server has, naming the router and the servers there are', async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .mount(
        newRouter('/jobs')
          .with(bindTo('nowhere'))
          .get('/', () => ({})),
      ) as WebApplication

    const error = await app.bootstrap().catch((error: unknown) => error)

    expect(error).toMatchObject({ code: 'ERR_CONFIGURATION' })
    expect((error as Error).message).toMatch(
      /^Cannot serve router "Jobs": it is bound to "nowhere", and no installed server has that name/,
    )
    expect((error as Error).message).toContain(`.install(Ops('nowhere', ...))`)
    expect((error as Error).message).toContain('"admin"')
  })

  it('has no ops servers to reach before bootstrap, and none when none was installed', async () => {
    app = createWebApplication()

    expect(() => app!.ops).toThrow(ErrApplicationNotReady)

    await app.bootstrap()

    expect(app.ops.size).toBe(0)
  })

  it('listens on each ops server with its own settings, whatever run() is given', async () => {
    const free = await new Promise<number>(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number }
        probe.close(() => resolve(port))
      })
    })

    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .mount(jobs()) as WebApplication

    // Handed to the ops server as well, the port would be taken twice and run() would reject.
    await app.run({ host: '127.0.0.1', port: free })

    expect(app.address!.port).toBe(free)
    expect(app.ops.get('admin')!.address!.port).not.toBe(free)
  })

  it('answers an injected request on an ops server, with nothing listening', async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .mount(jobs()) as WebApplication

    await app.bootstrap()
    const ops = app.ops.get('admin')!

    expect(ops.address).toBeUndefined()
    expect(await (await ops.fetch('/jobs')).json()).toEqual({ jobs: true })
    expect((await app.fetch('/jobs')).status).toBe(404)
  })
})
