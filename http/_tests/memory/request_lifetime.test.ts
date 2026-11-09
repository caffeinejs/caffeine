import { Hour, Millisecond } from '@caffeinejs/std/duration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Router, type IContext } from '../../index.js'
import { createWebApplication } from '../../platform/fastify/index.js'

/**
 * That a request's timer goes with the request: answered, timed out or left by its client, none leaves one running.
 * The timeout is an hour for the point of it: a timer a request did not clear would hold the request, its reply and
 * its signal for that long.
 */

const N = 200

/** The timers the process has running. */
function timers(): number {
  return process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length
}

// Let go by the test once a client has left, so a handler outlives its request.
let leftGate = Promise.withResolvers<void>()
let entered = Promise.withResolvers<void>()

const routes = new Router('/lifetime')
routes
  .post('/answered')
  .timeout(1 * Hour)
  .handler(() => 'ok')
routes
  .post('/timed-out')
  .timeout(5 * Millisecond)
  .handler(async (ctx: IContext) => {
    await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    return 'late'
  })
routes
  .post('/left')
  .timeout(1 * Hour)
  .handler(async () => {
    entered.resolve()
    await leftGate.promise
    return 'late'
  })

const app = createWebApplication()
  .server(() => ({ factory: { logger: false }, listener: { host: '127.0.0.1', port: 0 } }))
  .mount(routes)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  leftGate.resolve()
  await app.close()
})

const post = (path: string, signal?: AbortSignal) =>
  fetch(`${origin}/lifetime/${path}`, {
    method: 'POST',
    body: JSON.stringify({ a: 1 }),
    headers: { 'content-type': 'application/json' },
    signal,
  })

describe("a request's lifetime", () => {
  it('leaves no timer running, answered, timed out or left by its client', async () => {
    const before = timers()

    for (let i = 0; i < N; i++) {
      await (await post('answered')).text()

      const timedOut = await post('timed-out')
      expect(timedOut.status).toBe(503)
      await timedOut.text()

      const client = new AbortController()
      entered = Promise.withResolvers<void>()
      const leaving = post('left', client.signal).catch(() => undefined)
      await entered.promise
      client.abort()
      await leaving
    }

    // Every handler a client left lets go, and its late answer goes nowhere.
    leftGate.resolve()
    await new Promise(resolve => setImmediate(resolve))

    // Fewer is fine: a timer of the test runner's own may have ended meanwhile. One left per request is the leak.
    expect(timers()).toBeLessThanOrEqual(before)
  })
})
