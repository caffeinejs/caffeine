import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools } from '../devtools.js'
import type { RuntimeRecord } from './runtime.js'

/** A snapshot of the process an operator reads when it slows down: memory, CPU and how busy the event loop is. */
describe('RuntimeTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('reports memory, the heap, CPU, the event loop and what keeps it alive', async () => {
    app = createWebApplication().with(devTools()) as WebApplication
    await app.bootstrap()

    const runtime = (await (await app.fetch('/devtools/runtime')).json()) as RuntimeRecord

    expect(runtime.memory.heapUsed).toBeGreaterThan(0)
    expect(runtime.heap.heap_size_limit).toBeGreaterThan(runtime.memory.heapUsed)
    expect(runtime.resources.userCPUTime).toBeGreaterThan(0)
    expect(runtime.eventLoop.sinceStart).toBeGreaterThanOrEqual(0)
    expect(runtime.eventLoop.sinceStart).toBeLessThanOrEqual(1)
    expect(Object.values(runtime.activeResources).every(count => count > 0)).toBe(true)
  })
})
