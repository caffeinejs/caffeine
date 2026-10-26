import { brewer } from '@caffeinejs/brewer'
import { CaffeineIoC } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { testClient } from '@caffeinejs/testing/http'
import { afterEach, describe, expect, it } from 'vitest'

import { DevTools, type DevToolsRoutes } from '../devtools.js'
import { eventsRouter, EventsTool } from './events.js'

/**
 * Why an application failed to start, or what it built, is told by the container's events: they must name each
 * binding, carry a failure's message and keep their order.
 */
describe('eventsRouter', () => {
  class Pool {
    readonly at = Date.now()
  }

  /** The events of a container the test drives, read through the tool's own router. */
  function observe() {
    const container = new CaffeineIoC({ decorators: false })
    const tool = new EventsTool(container.hooks)

    return { container, events: testClient(eventsRouter(tool)) }
  }

  type Events = ReturnType<typeof observe>['events']

  async function list(events: Events, query: { after?: number; limit?: number } = {}) {
    const res = await events.events.get({ query })

    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }

    return res.json()
  }

  it("records a container's start-up, a failing binding with its message", async () => {
    class Broken {
      constructor() {
        throw new Error('no connection')
      }
    }

    const { container, events } = observe()
    await using _ = events
    container.bind(Pool, t => t.toSelf())
    container.bind(Broken, t => t.toSelf())

    await expect(container.init()).rejects.toThrow('no connection')

    const recorded = (await list(events)).map(({ kind, subject, error }) => ({
      kind,
      subject,
      error,
    }))
    expect(recorded).toEqual(
      expect.arrayContaining([
        { kind: 'binding-registered', subject: 'Pool', error: undefined },
        { kind: 'binding-initialized', subject: 'Pool', error: undefined },
        { kind: 'binding-initialization-failed', subject: 'Broken', error: 'no connection' },
      ]),
    )
  })

  it('masks the password of a connection string a failure names', async () => {
    class Database {
      constructor() {
        throw new Error('Cannot connect to postgres://app:hunter2@db/pets')
      }
    }

    const { container, events } = observe()
    await using _ = events
    container.bind(Database, t => t.toSelf())

    await expect(container.init()).rejects.toThrow()

    const failed = (await list(events)).find(event => event.kind === 'binding-initialization-failed')
    expect(failed?.error).toBe('Cannot connect to postgres://app:******@db/pets')
  })

  it('answers the events after a sequence number, and the last few', async () => {
    const { container, events } = observe()
    await using _ = events
    container.bind(Pool, t => t.toSelf())
    await container.init()

    const all = await list(events)
    const after = await list(events, { after: all[0]!.seq })
    const last = await list(events, { limit: 1 })
    // The last none is none, not all of them.
    const none = await list(events, { limit: 0 })
    const malformed = await events.$fetch('/events?after=x')

    expect(after.map(event => event.seq)).toEqual(all.slice(1).map(event => event.seq))
    expect(last).toEqual(all.slice(-1))
    expect(none).toEqual([])
    expect(malformed.status).toBe(400)
  })

  describe('under DevTools()', () => {
    let app: WebApplication | undefined

    afterEach(async () => {
      await app?.close()
      app = undefined
    })

    it("serves the application's start-up, since it attaches before the container initializes", async () => {
      app = createWebApplication({ logger: false })
        .server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
        .install(DevTools(d => d.port(0))) as WebApplication
      app.container.bind(Pool, t => t.toSelf())
      await app.run()
      const devtools = brewer<DevToolsRoutes>(`${app.listeners.get('devtools')!.address!.origin}/devtools`)

      const res = await devtools.events.get()

      expect(res.status).toBe(200)
      const events = res.status === 200 ? await res.json() : []

      expect(events.filter(event => event.subject === 'Pool').map(event => event.kind)).toEqual([
        'binding-registered',
        'binding-initialized',
      ])
      expect(events.map(event => event.seq)).toEqual(events.map((_, at) => events[0]!.seq + at))
    })
  })
})
