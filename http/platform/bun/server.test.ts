import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { Router } from '../../core/routing/programmatic/programmatic.js'
import { bun } from './bun.js'
import type { BunServeOptions, BunServer } from './runtime.js'

/** `Bun.serve` as the adapter calls it, under Node: what it was handed, and a server that records what it is told. */
interface FakeBun {
  readonly server: BunServer
  /** Each `timeout(request, seconds)` call's seconds, in order. */
  readonly timeouts: number[]
  options(): BunServeOptions
}

let fake: FakeBun
let stop: (closeActiveConnections?: boolean) => Promise<void>

beforeEach(() => {
  const timeouts: number[] = []
  let handed: BunServeOptions | undefined
  stop = () => Promise.resolve()

  const server: BunServer = {
    address: { address: '127.0.0.1', port: 4000 },
    hostname: '127.0.0.1',
    port: 4000,
    url: new URL('http://127.0.0.1:4000/'),
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: (_request, seconds) => void timeouts.push(seconds),
    stop: closeActiveConnections => stop(closeActiveConnections),
  }

  fake = { server, timeouts, options: () => handed! }
  ;(globalThis as { Bun?: unknown }).Bun = {
    serve: (options: BunServeOptions) => {
      handed = options
      return server
    },
  }
})

afterEach(() => {
  delete (globalThis as { Bun?: unknown }).Bun
})

async function running(): Promise<WebApplication<unknown, unknown>> {
  const app = createWebApplication({ adapter: bun() })
    .server(() => ({ listen: { host: '127.0.0.1', port: 0 } }))
    .mount(new Router('/hi').get('/').handler(() => 'hi'))
  await app.run()
  return app
}

describe('BunHostedServer', () => {
  // A connection whose request is being answered must not be cut, however long it is silent; one idle after its answer
  // must be, or every client that goes quiet holds its socket for good.
  it('lifts the idle cut while a request is answered, and puts it back as the answer is handed over', async () => {
    const app = await running()

    try {
      const res = await fake.options().fetch(new Request('http://127.0.0.1:4000/hi'), fake.server)

      expect(res.status).toBe(200)
      expect(fake.options().idleTimeout).toBe(72)
      expect(fake.timeouts).toEqual([0, 72])
    } finally {
      await app.close()
    }
  })

  it('reports no address once closed, even when Bun fails to stop', async () => {
    const app = await running()
    stop = () => Promise.reject(new Error('stop failed'))

    await app.close().catch(() => undefined)

    expect(app.address).toBe(undefined)
  })
})
