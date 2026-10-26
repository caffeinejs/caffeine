import { CaffeineIoC } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { DevTools } from '../devtools.js'
import { EventsTool, type ContainerEventRecord } from './events.js'

/**
 * Why an application failed to start, or what it built, is told by the container's events: they must name each
 * binding, carry a failure's message and keep their order.
 */
describe('EventsTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  class Pool {
    readonly at = Date.now()
  }

  async function list(tool: EventsTool, query: Record<string, string> = {}): Promise<ContainerEventRecord[]> {
    const [operation] = tool.operations
    return (await operation.handle({ params: {}, query, body: undefined, signal: AbortSignal.timeout(1000) })) as never
  }

  it("records a container's start-up, a failing binding with its message", async () => {
    class Broken {
      constructor() {
        throw new Error('no connection')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    const tool = new EventsTool(container.hooks)
    container.bind(Pool, t => t.toSelf())
    container.bind(Broken, t => t.toSelf())

    await expect(container.init()).rejects.toThrow('no connection')

    const recorded = (await list(tool)).map(({ kind, subject, error }) => ({ kind, subject, error }))

    expect(recorded).toEqual(
      expect.arrayContaining([
        { kind: 'binding-registered', subject: 'Pool', error: undefined },
        { kind: 'binding-initialized', subject: 'Pool', error: undefined },
        { kind: 'binding-initialization-failed', subject: 'Broken', error: 'no connection' },
      ]),
    )
  })

  it("serves the application's start-up from DevTools(), which attaches before the container initializes", async () => {
    app = createWebApplication().install(DevTools()) as WebApplication
    app.container.bind(Pool, t => t.toSelf())
    await app.bootstrap()

    const res = await app.listeners.get('devtools')!.fetch('/devtools/events')
    const events = (await res.json()) as ContainerEventRecord[]

    expect(events.filter(event => event.subject === 'Pool').map(event => event.kind)).toEqual([
      'binding-registered',
      'binding-initialized',
    ])
    expect(events.map(event => event.seq)).toEqual(events.map((_, at) => events[0].seq + at))
  })

  it('answers the events after a sequence number, and the last few', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const tool = new EventsTool(container.hooks)
    container.bind(Pool, t => t.toSelf())
    await container.init()

    const [first] = await list(tool)

    expect((await list(tool, { after: String(first.seq) })).map(event => event.seq)).not.toContain(first.seq)
    expect(await list(tool, { limit: '1' })).toHaveLength(1)
    await expect(list(tool, { after: 'x' })).rejects.toMatchObject({ code: 'ERR_DEVTOOL_INVALID' })
  })
})
