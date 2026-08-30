import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import type { ServiceAPI } from '@caffeinejs/std'
import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { ErrShutdownTimeout } from '../health/errors.js'
import type { HealthBuilder } from '../health/health_builder.js'
import type { WebApplication } from '../application.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

@Controller('/drain')
class DrainController {
  @Get('/fast')
  fast() {
    return { ok: true }
  }

  @Get('/slow')
  async slow() {
    await sleep(3_000)
    return { ok: true }
  }
}

void [DrainController]

async function start(configure: (health: ServiceAPI<HealthBuilder<unknown>>) => void): Promise<WebApplication> {
  const app = createWebApplication(fastifyAdapterFactory(fastify()))
    .health(configure)
    .build()

  await app.run()

  return app
}

function portOf(app: WebApplication): number {
  const address = app.instance.server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address')
  }

  return address.port
}

describe('graceful shutdown', () => {
  it('refuses readiness before the drain delay elapses, while liveness stays up', async () => {
    const app = await start(h => h.drainDelay(300))

    expect((await app.fetch('/readyz')).status).toBe(200)

    const closing = app.close()

    // No await in between: the flip has to be visible on the very next poll, not after the delay.
    const ready = await app.fetch('/readyz')
    const live = await app.fetch('/livez')

    expect(ready.status).toBe(503)
    expect(live.status).toBe(200)
    expect(app.instance.server.listening).toBe(true)

    await closing
  })

  it('keeps serving traffic normally throughout the drain delay', async () => {
    const app = await start(h => h.drainDelay(300))
    const port = portOf(app)

    const closing = app.close()

    await sleep(100)

    // The routing table has not caught up yet, so requests are still arriving and must be answered.
    const response = await fetch(`http://127.0.0.1:${port}/drain/fast`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    await closing
  })

  it('does not tear the server down until the delay has elapsed', async () => {
    const app = await start(h => h.drainDelay(300))

    const closing = app.close()

    await sleep(100)
    expect(app.instance.server.listening).toBe(true)

    await closing
    expect(app.instance.server.listening).toBe(false)
  })

  it('runs the pre-shutdown hooks after the drain delay, not before', async () => {
    const app = await start(h => h.drainDelay(300))

    let hookAt = 0
    app.on('application:pre-shutdown', () => {
      hookAt = Date.now()
    })

    const startedAt = Date.now()
    await app.close()

    expect(hookAt - startedAt).toBeGreaterThanOrEqual(250)
  })

  it('skips the wait when the drain delay is zero', async () => {
    const app = await start(h => h.drainDelay(0))

    const startedAt = Date.now()
    await app.close()

    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  it('forces connections shut and reports a timeout when in-flight requests overrun the budget', async () => {
    const app = await start(h => h.drainDelay(0).shutdownTimeout(200))
    const port = portOf(app)

    const inflight = fetch(`http://127.0.0.1:${port}/drain/slow`).catch(() => undefined)
    await sleep(50)

    const error = await app.close().catch((error: unknown) => error)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect(app.instance.server.listening).toBe(false)

    await inflight
  })

  it('joins a second close instead of starting another one', async () => {
    const app = await start(h => h.drainDelay(200))

    let hooks = 0
    app.on('application:pre-shutdown', () => {
      hooks++
    })

    await Promise.all([app.close(), app.close()])

    expect(hooks).toBe(1)
  })

  it('installs no signal handlers under a test environment', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = await start(() => {})

    expect(process.listenerCount('SIGTERM')).toBe(before)

    await app.close()
  })

  it('installs and removes the configured signal handlers', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = await start(h => h.signals(['SIGTERM']).drainDelay(0))

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await app.close()

    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})
