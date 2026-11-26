import type { Server as HTTPServer } from 'node:http'

import { kFeatureConfigure, kFeatureName, type Feature } from '@caffeinejs/application'
import { newNoopLogger, type Logger } from '@caffeinejs/application/logger'
import { Byte } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'
import { describe, expect, it, vi } from 'vitest'

import { createWebApplication, type WebApplication } from './application.js'
import { findMyWayMatcher } from './core/matcher/find_my_way.js'
import type { RouteMatcherFactory } from './core/matcher/matcher.js'
import { Router } from './core/routing/programmatic/programmatic.js'
import { node } from './platform/node.testkit.js'
import { HTTPPlugin, type HTTPSetupContext } from './plugin.js'
import { ServerDefinition } from './server_definition.js'
import { ServerSet } from './servers.js'

describe('ServerSet', () => {
  // `named` feeds `app.listeners`, read once every server is built: a partial map would hand out servers that are not.
  it('hands out no named servers until every server is built', () => {
    const servers = new ServerSet([new ServerDefinition(), new ServerDefinition('admin')])

    expect(servers.names).toEqual(['admin'])
    expect(servers.own).toBeUndefined()
    expect(servers.named).toBeUndefined()
  })

  // A configurer that leaves a section out, as `undefined`, does not erase what an earlier one set for it.
  it('keeps a section an earlier .server(...) set when a later one leaves it undefined', async () => {
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ bodyLimit: 8 * Byte }))
      .server(() => ({ bodyLimit: undefined }))
      .mount(new Router('/limited').post('/', () => ({ ok: true })))

    try {
      await app.bootstrap()

      const res = await app.request('/limited', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ longer: 'than eight bytes' }),
      })

      expect(res.status).toBe(413)
    } finally {
      await app.close()
    }
  })

  // `.hook(...)` and `.with(...)` share one list: a hook runs where it was written among the plugins.
  it('runs hooks and plugin hooks in the order written', async () => {
    const order: string[] = []
    const fetchApp = createWebApplication()
      .hook('onRequest', () => void order.push('first'))
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server: ops }: HTTPSetupContext): void {
              ops.hook('onRequest', () => void order.push('plugin'))
            }
          })(),
      )
      // A feature takes no slot: it leaves the order of the hooks around it as written.
      .install(slotless)
      .hook('onRequest', () => void order.push('last'))
      .mount(new Router('/x').get('/').handler(() => 'x'))

    try {
      await fetchApp.bootstrap()
      await fetchApp.request('/x')
    } finally {
      await fetchApp.close().catch(() => undefined)
    }

    expect(order).toEqual(['first', 'plugin', 'last'])
  })

  // Only an object section merges over the one before it: a list merged by index would keep stale entries. An
  // in-process request comes from 127.0.0.1, which only the first list trusts.
  it('replaces an array section, never merging it', async () => {
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ trustProxy: ['10.0.0.1', '127.0.0.1'] }))
      .server(() => ({ trustProxy: ['10.0.0.2'] }))
      .mount(new Router('/h').get('/', ctx => ctx.req.host))

    try {
      await app.bootstrap()

      const res = await app.request('http://localhost/h', { headers: { 'x-forwarded-host': 'proxied.example' } })

      expect(await res.text()).toBe('localhost')
    } finally {
      await app.close()
    }
  })

  // Only `undefined` leaves an earlier section in place: `null` is a value like any other, and the setting refuses it.
  it('takes null as a section that replaces the one before it', async () => {
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ handlerTimeout: 5 * Second }))
      .server(() => ({ handlerTimeout: null }) as never)

    try {
      await expect(app.bootstrap()).rejects.toThrow('Cannot set handlerTimeout to "null"')
    } finally {
      await app.close()
    }
  })

  // close() after a failed bootstrap() tears down what the boot brought up: an engine whose server never got built too.
  it.each<[string, (closed: string[], boom: Error) => WebApplication]>([
    [
      'its Node server failed to build',
      (closed, boom) =>
        createWebApplication({ adapter: node() })
          .hook('onClose', () => void closed.push('closed'))
          .serverCallback(() => {
            throw boom
          }),
    ],
    [
      'its onReady failed',
      (closed, boom) =>
        createWebApplication()
          .hook('onReady', () => {
            throw boom
          })
          .hook('onClose', () => void closed.push('closed')),
    ],
  ])('runs the onClose hooks of a server when %s, once close() is called', async (_what, build) => {
    const boom = new Error('boom')
    const closed: string[] = []
    const app = build(closed, boom)

    try {
      await expect(app.bootstrap()).rejects.toBe(boom)
    } finally {
      await app.close()
    }

    expect(closed).toEqual(['closed'])
  })
})

/** A feature that binds nothing. */
const slotless = {
  get [kFeatureName]() {
    return 'slotless'
  },
  [kFeatureConfigure]() {},
} as Feature

describe('ServerSet teardown', () => {
  // A server plugin that registered holds what it opened until its `onClose` runs: a later plugin failing start-up
  // leaves no engine to run it, so the server's teardown does.
  it("runs the onClose of the plugins that registered when a router's plugin fails start-up", async () => {
    const closed: string[] = []
    const app = createWebApplication({ adapter: node() })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              server.hook('onClose', () => void closed.push('server'))
            }
          })(),
      )
      .mount(
        new Router('/r')
          .with(() => {
            throw new Error('router plugin failed')
          })
          .get('/', () => 'r'),
      )

    const err = await app.bootstrap().catch((err: unknown) => err)
    await app.close()

    expect([(err as Error).message, closed]).toEqual(['router plugin failed', ['server']])
  })

  // A plugin that registered its `onClose` before it failed holds what it opened too: its own hook runs, once.
  it('runs the onClose a plugin registered before its own registration failed, once', async () => {
    const closed: string[] = []
    const app = createWebApplication({ adapter: node() }).with(
      () =>
        new (class extends HTTPPlugin {
          register({ server }: HTTPSetupContext): void {
            server.hook('onClose', () => void closed.push('self'))
            throw new Error('register failed')
          }
        })(),
    )

    const err = await app.bootstrap().catch((err: unknown) => err)
    await app.close()
    await app.close()

    expect([(err as Error).message, closed]).toEqual(['register failed', ['self']])
  })

  // Every close that fails is reported, not the first alone: a failed start-up's close logs what its teardown hit.
  it('reports every onClose that failed after start-up failed', async () => {
    const failing = (message: string) => () =>
      new (class extends HTTPPlugin {
        register({ server }: HTTPSetupContext): void {
          server.hook('onClose', () => {
            throw new Error(message)
          })
        }
      })()
    const errors = vi.fn()
    const logger: Logger = { ...newNoopLogger(), error: errors }
    const app = createWebApplication({ adapter: node() })
      .logger(b => b.use(logger))
      .with(failing('first'))
      .with(failing('second'))
      .mount(
        new Router('/r')
          .with(() => {
            throw new Error('router plugin failed')
          })
          .get('/', () => 'r'),
      )

    await app.bootstrap().catch(() => undefined)
    await app.close()

    const logged = errors.mock.calls.map(([fields]) => (fields as { err: unknown }).err)
    const aggregate = logged.find((err): err is AggregateError => err instanceof AggregateError)
    expect(aggregate?.errors.map((err: Error) => err.message)).toEqual(['first', 'second'])
  })
})

describe('context.server', () => {
  /** A plugin that records what its scoped server says of the server it registers on. */
  function recorder(seen: unknown[]): () => HTTPPlugin {
    return () =>
      new (class extends HTTPPlugin {
        register({ server }: HTTPSetupContext): void {
          seen.push({ basePath: server.basePath, matcher: server.matcher })
        }
      })()
  }

  /** A plugin that records the server's name and the scope's prefix. */
  function placer(seen: unknown[]): () => HTTPPlugin {
    return () =>
      new (class extends HTTPPlugin {
        register({ server }: HTTPSetupContext): void {
          seen.push({ name: server.name, basePath: server.basePath, prefix: server.prefix })
        }
      })()
  }

  async function serverSeen(build: (seen: unknown[]) => { bootstrap(): Promise<unknown>; close(): Promise<void> }) {
    const seen: unknown[] = []
    const app = build(seen)

    try {
      await app.bootstrap()
    } finally {
      await app.close()
    }

    return seen
  }

  it("reports the base path on the application's own slot", async () => {
    expect(await serverSeen(seen => createWebApplication().basePath('/api').with(recorder(seen)))).toEqual([
      { basePath: '/api', matcher: findMyWayMatcher },
    ])
  })

  it.each([
    ['/api/', '/api'],
    ['/', ''],
  ])('normalizes the base path %s to %s', async (given, expected) => {
    expect(await serverSeen(seen => createWebApplication().basePath(given).with(recorder(seen)))).toEqual([
      { basePath: expected, matcher: findMyWayMatcher },
    ])
  })

  it('merges an object section over the one before it', async () => {
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ http: { keepAliveTimeout: 1234 } }))
      .server(() => ({ http: { headersTimeout: 5678 } }))

    try {
      await app.bootstrap()

      const server = app.instance as HTTPServer
      expect([server.keepAliveTimeout, server.headersTimeout]).toEqual([1234, 5678])
    } finally {
      await app.close()
    }
  })

  it('reports an empty base path when the application set none', async () => {
    expect(await serverSeen(seen => createWebApplication().with(recorder(seen)))).toEqual([
      { basePath: '', matcher: findMyWayMatcher },
    ])
  })

  // A router's plugins register on the server it is mounted on, so they know that server as the server's own do.
  it("reports the server a router's plugin registers on", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication().mount(
          new Router('/r')
            .with(recorder(seen))
            .get('/')
            .handler(() => 'ok'),
        ),
      ),
    ).toEqual([{ basePath: '', matcher: findMyWayMatcher }])
  })

  // What a plugin builds URLs from: the server it is on, and where its scope starts on that server.
  it('reports the server name and the scope prefix wherever a plugin registers', async () => {
    const seen: unknown[] = []
    const nested = new Router('/n')
      .with(placer(seen))
      .get('/')
      .handler(() => 'ok')
    const app = createWebApplication({ adapter: node() })
      .basePath('/api')
      .with(placer(seen))
      .mount(new Router('/r').with(placer(seen)).mount(nested))
      .listener('admin', l => l.with(placer(seen)).mount(new Router('/ops').with(placer(seen)).mount(nested)))

    try {
      await app.bootstrap()
    } finally {
      await app.close()
    }

    expect(seen).toEqual([
      { name: undefined, basePath: '/api', prefix: '' },
      { name: undefined, basePath: '/api', prefix: '/r' },
      { name: undefined, basePath: '/api', prefix: '/r/n' },
      { name: 'admin', basePath: '', prefix: '' },
      { name: 'admin', basePath: '', prefix: '/ops' },
      { name: 'admin', basePath: '', prefix: '/ops/n' },
    ])
  })

  // `.server(...)` builds the server: its context has none, and the type says so.
  it('hands .server(...) a context without a server', async () => {
    const seen: unknown[] = []
    const app = createWebApplication().server(context => {
      seen.push('server' in context)
      return {}
    })

    try {
      await app.bootstrap()
    } finally {
      await app.close()
    }

    expect(seen).toEqual([false])
  })

  it("reports the listener's server on a listener's slot", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication({ adapter: node() })
          .basePath('/api')
          .listener('admin', l => l.with(recorder(seen))),
      ),
    ).toEqual([{ basePath: '', matcher: findMyWayMatcher }])
  })

  // A plugin that asks how the server ranks routes, as staticFiles() does, builds its probe with the server's own
  // matcher.
  it("reports the server's own matcher", async () => {
    const matcher: RouteMatcherFactory = strategies => findMyWayMatcher(strategies)

    expect(
      await serverSeen(seen =>
        createWebApplication()
          .server(() => ({ matcher }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', matcher }])
  })

  // Read on each access: a plugin holding its server sees where it listens once it does, and nothing before.
  it('reports where the server listens once it does', async () => {
    let held: HTTPSetupContext['server'] | undefined
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ listen: { host: '127.0.0.1', port: 0 } }))
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              held = server
            }
          })(),
      )
      .mount(new Router('/ping').get('/', () => 'pong'))

    try {
      await app.bootstrap()
      const before = held!.address
      await app.run()
      const address = held!.address!

      const res = await fetch(`http://127.0.0.1:${address.port}/ping`)
      expect([before, address.host, res.status, await res.text()]).toEqual([undefined, '127.0.0.1', 200, 'pong'])
    } finally {
      await app.close()
    }
  })
})
