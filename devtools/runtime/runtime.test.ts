import { createServer } from 'node:net'

import { testClient } from '@caffeinejs/testing/http'
import { afterEach, describe, expect, it } from 'vitest'

import { runtimeRouter } from './runtime.route.js'
import { RuntimeTool } from './runtime.tool.js'

/** A snapshot of the process an operator reads when it slows down: memory, CPU and how busy the event loop is. */
describe('runtimeRouter', () => {
  const server = createServer()

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('reports memory, the heap, CPU, the event loop and what keeps it alive', async () => {
    // A listening socket is one of what keeps the event loop alive.
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await using client = testClient(runtimeRouter(new RuntimeTool()))

    const res = await client.runtime.get()

    expect(res.status).toBe(200)
    const runtime = await res.json()
    expect(runtime.memory.heapUsed).toBeGreaterThan(0)
    expect(runtime.heap.heap_size_limit).toBeGreaterThan(runtime.memory.heapUsed)
    expect(runtime.resources.userCPUTime).toBeGreaterThan(0)
    expect(runtime.eventLoop.sinceStart).toBeGreaterThanOrEqual(0)
    expect(runtime.eventLoop.sinceStart).toBeLessThanOrEqual(1)
    expect(runtime.activeResources.TCPServerWrap).toBeGreaterThanOrEqual(1)
  })
})
