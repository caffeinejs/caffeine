import { connect, type Socket } from 'node:net'

import { ErrApplicationClosed, ErrApplicationRunning } from '@caffeinejs/application'
import { ErrShutdownTimeout, type ShutdownBuilder } from '@caffeinejs/application/shutdown'
import { Injectable, type OnDestroy } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { WebApplication } from '../application.js'
import { Controller, Get } from '../index.js'
import { createWebApplication, healthProbes } from '../platform/fastify/index.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// A container OnDestroy hook runs inside `container.dispose()`, which Application calls only after the
// drain delay and after the server has stopped. `onDestroyHook` lets a test observe when that happens.
let onDestroyHook: (() => void | Promise<void>) | undefined

// `/drain/slow` answers once `slowHook` settles, so a test decides how long a request stays in flight.
let slowHook: (() => Promise<void>) | undefined

@Injectable()
class ShutdownProbe implements OnDestroy {
  onDestroy() {
    return onDestroyHook?.()
  }
}

void [ShutdownProbe]

beforeEach(() => {
  onDestroyHook = undefined
  slowHook = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

@Controller('/drain')
class DrainController {
  @Get('/fast')
  fast() {
    return { ok: true }
  }

  @Get('/slow')
  async slow() {
    await slowHook?.()
    return { ok: true }
  }
}

void [DrainController]

async function start(configure: (shutdown: ShutdownBuilder<unknown>) => void): Promise<WebApplication> {
  // health() mounts the probes the readiness/liveness assertions poll; `.shutdown()` owns the drain.
  const app = createWebApplication().with(healthProbes()).shutdown(configure)

  // The in-flight request below dials 127.0.0.1, so the bind is pinned to it rather than left to `localhost`.
  await app.run({ host: '127.0.0.1', port: 0 })

  return app
}

function portOf(app: WebApplication): number {
  const address = app.instance.server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address')
  }

  return address.port
}

/** A client connection that has sent nothing, once the server has accepted it. */
async function silentConnection(app: WebApplication): Promise<Socket> {
  const accepted = new Promise(resolve => app.instance.server.once('connection', resolve))
  const socket = connect(portOf(app), '127.0.0.1')
  socket.on('error', () => undefined)
  await accepted

  return socket
}

/**
 * A client connection that sends `request` as it opens, once the server has accepted it. Sent after the accept, the
 * bytes could arrive once the server had already judged the connection silent.
 */
async function connectionSending(app: WebApplication, request: string): Promise<Socket> {
  const accepted = new Promise(resolve => app.instance.server.once('connection', resolve))
  const socket = connect(portOf(app), '127.0.0.1')
  socket.on('error', () => undefined)
  socket.write(request)
  await accepted

  return socket
}

/** A keep-alive connection whose one request has been answered, left idle. */
async function idleConnection(app: WebApplication): Promise<Socket> {
  const socket = connect(portOf(app), '127.0.0.1')
  socket.on('error', () => undefined)
  socket.setEncoding('utf8')

  let received = ''
  const answered = new Promise<void>(resolve =>
    socket.on('data', (chunk: string) => {
      received += chunk
      if (received.endsWith('{"ok":true}')) {
        resolve()
      }
    }),
  )
  socket.write('GET /drain/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  await answered

  return socket
}

describe('graceful shutdown', () => {
  it('refuses readiness before the drain delay elapses, while liveness stays up', async () => {
    const app = await start(s => s.drainDelay(300))

    expect((await app.request('/readyz')).status).toBe(200)

    const closing = app.close()

    // No await in between: the flip has to be visible on the very next poll, not after the delay.
    const ready = await app.request('/readyz')
    const live = await app.request('/livez')

    expect(ready.status).toBe(503)
    expect(live.status).toBe(200)
    expect(app.instance.server.listening).toBe(true)

    await closing
  })

  it('keeps serving traffic normally throughout the drain delay', async () => {
    const app = await start(s => s.drainDelay(300))
    const port = portOf(app)

    // On real timers: undici builds its clock on the first fetch, and a fake one would never tick again here.
    expect((await fetch(`http://127.0.0.1:${port}/drain/fast`)).status).toBe(200)

    // Only the drain timer is faked, so the delay cannot end before the request below is answered.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = app.close()

    await vi.advanceTimersByTimeAsync(100)

    // The routing table has not caught up yet, so requests are still arriving and must be answered.
    const response = await fetch(`http://127.0.0.1:${port}/drain/fast`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()
    await closing
  })

  it('does not tear the server down until the delay has elapsed', async () => {
    const app = await start(s => s.drainDelay(300))

    const closing = app.close()

    await sleep(100)
    expect(app.instance.server.listening).toBe(true)

    await closing
    expect(app.instance.server.listening).toBe(false)
  })

  it('disposes the container after the drain delay, not before', async () => {
    const app = await start(s => s.drainDelay(300))

    let hookAt = 0
    onDestroyHook = () => {
      hookAt = Date.now()
    }

    const startedAt = Date.now()
    await app.close()

    expect(hookAt - startedAt).toBeGreaterThanOrEqual(250)
  })

  it('skips the wait when the drain delay is zero', async () => {
    const app = await start(s => s.drainDelay(0))
    // The clock stands still, so a close that waited on a drain timer would never settle.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await app.close()

    expect(app.instance.server.listening).toBe(false)
  })

  it('forces connections shut and reports a timeout when in-flight requests overrun the budget', async () => {
    const app = await start(s => s.drainDelay(0).shutdownTimeout(200))
    const port = portOf(app)

    let started!: () => void
    const inFlight = new Promise<void>(resolve => (started = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    slowHook = () => {
      started()
      return held
    }

    const request = fetch(`http://127.0.0.1:${port}/drain/slow`).catch(() => undefined)
    await inFlight

    const error = await app.close().catch((error: unknown) => error)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect(app.instance.server.listening).toBe(false)

    release()
    await request
  })

  // Node counts a connection that has not sent a request as active, never idle, and stops expiring it once the
  // server closes: a browser's preconnect, a load balancer's TCP check or the spare connection `fetch` opens after
  // an abort held the close until the budget ran out.
  it('closes a connection that never sent a request instead of waiting out the budget', async () => {
    const app = await start(s => s.drainDelay(0).shutdownTimeout(5 * Second))
    const client = await silentConnection(app)
    const hungUp = new Promise(resolve => client.once('close', resolve))

    await expect(app.close()).resolves.toBeUndefined()
    await hungUp
  })

  // What a connection had already sent when closing began is a request, not silence, even before the server has
  // read it: it gets the 503 Fastify answers every request with once closing, not a reset.
  it('answers a request whose bytes arrived as closing began', async () => {
    const app = await start(s => s.drainDelay(0).shutdownTimeout(5 * Second))
    const client = await silentConnection(app)
    client.setEncoding('utf8')
    let received = ''
    client.on('data', (chunk: string) => (received += chunk))
    const hungUp = new Promise(resolve => client.once('close', resolve))

    client.write('GET /drain/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await expect(app.close()).resolves.toBeUndefined()
    await hungUp

    expect(received).toMatch(/^HTTP\/1\.1 503 /)
  })

  // The server listens until its `preClose` hooks have run, so a client can still connect once closing has begun.
  it('closes a connection that opens while the server is closing', async () => {
    let closing!: () => void
    let resume!: () => void
    const preClose = new Promise<void>(resolve => (closing = resolve))
    const held = new Promise<void>(resolve => (resume = resolve))

    const app = createWebApplication()
      .serverCallback((_context, instance) => {
        instance.addHook('preClose', async () => {
          closing()
          await held
        })
      })
      .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
    await app.run({ host: '127.0.0.1', port: 0 })

    const closed = app.close()
    await preClose
    await silentConnection(app)
    resume()

    await expect(closed).resolves.toBeUndefined()
  })

  // One that opens while the server is closing is judged like any other, once the server has read from it: a request
  // gets the 503 Fastify answers with while closing, not a reset.
  it('answers a request on a connection that opens while the server is closing', async () => {
    let closing!: () => void
    let resume!: () => void
    const preClose = new Promise<void>(resolve => (closing = resolve))
    const held = new Promise<void>(resolve => (resume = resolve))

    const app = createWebApplication()
      .serverCallback((_context, instance) => {
        instance.addHook('preClose', async () => {
          closing()
          await held
        })
      })
      .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
    await app.run({ host: '127.0.0.1', port: 0 })

    const closed = app.close()
    await preClose
    const client = await connectionSending(app, 'GET /drain/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    client.setEncoding('utf8')
    let received = ''
    client.on('data', (chunk: string) => (received += chunk))
    const hungUp = new Promise(resolve => client.once('close', resolve))
    await hungUp
    resume()

    expect(received).toMatch(/^HTTP\/1\.1 503 /)
    await expect(closed).resolves.toBeUndefined()
  })

  // Node ends the idle connections once, as the server stops accepting. One whose request finished after that was
  // kept alive for the client, and the close waited on it until the budget ran out.
  it('lets a request in flight finish, then closes the connection it kept alive', async () => {
    const app = await start(s => s.drainDelay(0).shutdownTimeout(5 * Second))
    const port = portOf(app)

    let started!: () => void
    const inFlight = new Promise<void>(resolve => (started = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    slowHook = () => {
      started()
      return held
    }

    const idle = await idleConnection(app)
    const request = fetch(`http://127.0.0.1:${port}/drain/slow`)
    await inFlight

    // The server ends the idle connection as it stops accepting, so the request in flight finishes after that.
    idle.once('close', release)
    const closed = app.close()

    const response = await request
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    await expect(closed).resolves.toBeUndefined()
  })

  it('joins a second close instead of starting another one', async () => {
    const app = await start(s => s.drainDelay(200))

    let hooks = 0
    onDestroyHook = () => {
      hooks++
    }

    await Promise.all([app.close(), app.close()])

    expect(hooks).toBe(1)
  })

  // The budget covers the container as well as the server. It used to bound the Fastify teardown alone, so a
  // destroy hook could run for as long as it liked on top of the window validated against the grace period —
  // and the overrun was never reported.
  it('holds the container disposal inside the teardown budget too', async () => {
    const app = await start(s => s.drainDelay(0).shutdownTimeout(100))

    onDestroyHook = () => sleep(400)

    const error = (await app.close().catch((error: unknown) => error)) as AggregateError

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.filter(e => e instanceof ErrShutdownTimeout)).toHaveLength(1)
  })

  it('installs no signal handlers under a test environment', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = await start(() => {})

    expect(process.listenerCount('SIGTERM')).toBe(before)

    await app.close()
  })

  it('installs and removes the configured signal handlers', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = await start(s => s.signals(['SIGTERM']).drainDelay(0))

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await app.close()

    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

// An application runs once, and a close is final. A server a late run() opened would outlive the close — the process
// never exits — and a second run() racing the first would change where the first one listens.
describe('running once', () => {
  it('opens no server once the application has been closed', async () => {
    const app = createWebApplication().shutdown(s => s.drainDelay(0))
    await app.bootstrap()
    await app.close()

    await expect(app.run({ host: '127.0.0.1', port: 0 })).rejects.toThrow(ErrApplicationClosed)
    expect(app.instance.server.listening).toBe(false)
  })

  it('listens where the first run() asked, refusing a second one made while it boots', async () => {
    const app = createWebApplication().shutdown(s => s.drainDelay(0))

    const first = app.run({ host: '127.0.0.1', port: 0 })

    await expect(app.run({ host: '127.0.0.1', port: 1 })).rejects.toThrow(ErrApplicationRunning)
    await first

    expect(portOf(app)).not.toBe(1)
    await app.close()
  })
})
