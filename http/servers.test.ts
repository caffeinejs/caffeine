import { kFeatureConfigure, kFeatureName, type Feature } from '@caffeinejs/application'
import { Byte } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from './application.js'
import { ErrConfiguration } from './core/error/common.js'
import { findMyWayMatcher } from './core/matcher/find_my_way.js'
import { DEFAULT_ROUTER_FLAGS } from './core/matcher/matcher.js'
import { Router } from './core/routing/programmatic/programmatic.js'
import { fetchAdapter, kHosting, type FetchAdapter } from './core/server/hosting.js'
import { node } from './platform/node/node.js'
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

  it('keeps an earlier multipart cap when the next layer supplies undefined for that key', async () => {
    const seen: unknown[] = []
    const adapter: FetchAdapter = {
      [kHosting](settings) {
        const hosting = fetchAdapter[kHosting](settings)
        seen.push(hosting.settings.multipart)
        return hosting
      },
    }
    const app = createWebApplication({ adapter })
      .server(() => ({ multipart: { maxFiles: 0, maxParts: 8 } }))
      .server(() => ({ multipart: { maxFiles: undefined, maxParts: 4 } }))

    try {
      await app.bootstrap()
      expect(seen).toEqual([{ maxFiles: 0, maxParts: 4 }])
    } finally {
      await app.close()
    }
  })

  it.each([
    { multipart: new Map([['maxFiles', 0]]) },
    { multipart: Object.defineProperty({}, 'maxPart', { value: 8 }) },
    { multipart: { maxParts: -1 } },
  ])('refuses an invalid multipart layer before later server settings can hide it: %o', async settings => {
    const app = createWebApplication()
      .server(() => settings as never)
      .server(() => ({ multipart: { maxParts: 4 } }))

    try {
      await expect(app.bootstrap()).rejects.toThrow(ErrConfiguration)
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
            register({ app: ops }: HTTPSetupContext): void {
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

  // Only `undefined` leaves an earlier section in place: `null` is a value like any other, and the router refuses it.
  it('takes null as a section that replaces the one before it', async () => {
    const app = createWebApplication({ adapter: node() })
      .server(() => ({ router: { caseSensitive: false } }))
      .server(() => ({ router: null }) as never)

    try {
      await expect(app.bootstrap()).rejects.toThrow('Cannot set router to "null"')
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

describe('context.app.server', () => {
  /** A plugin that records what its slot says of the server it registers on. */
  function recorder(seen: unknown[]): () => HTTPPlugin {
    return () =>
      new (class extends HTTPPlugin {
        register(context: HTTPSetupContext): void {
          seen.push(context.app.server)
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
      { basePath: '/api', router: DEFAULT_ROUTER_FLAGS },
    ])
  })

  it.each([
    ['/api/', '/api'],
    ['/', ''],
  ])('normalizes the base path %s to %s', async (given, expected) => {
    expect(await serverSeen(seen => createWebApplication().basePath(given).with(recorder(seen)))).toEqual([
      { basePath: expected, router: DEFAULT_ROUTER_FLAGS },
    ])
  })

  it('merges an object section over the one before it', async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication({ adapter: node() })
          .server(() => ({ router: { caseSensitive: false } }))
          .server(() => ({ router: { ignoreTrailingSlash: true } }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: { ...DEFAULT_ROUTER_FLAGS, caseSensitive: false, ignoreTrailingSlash: true } }])
  })

  it('reports an empty base path when the application set none', async () => {
    expect(await serverSeen(seen => createWebApplication().with(recorder(seen)))).toEqual([
      { basePath: '', router: DEFAULT_ROUTER_FLAGS },
    ])
  })

  // A router's slot is shared by every server that serves it: it belongs to none.
  it("reports no server on a router's slot", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication().mount(
          new Router('/r')
            .with(recorder(seen))
            .get('/')
            .handler(() => 'ok'),
        ),
      ),
    ).toEqual([undefined])
  })

  it("reports the listener's server on a listener's slot", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication({ adapter: node() })
          .basePath('/api')
          .listener('admin', l => l.with(recorder(seen))),
      ),
    ).toEqual([{ basePath: '', router: DEFAULT_ROUTER_FLAGS }])
  })

  it('reports the router flags .server(...) set', async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication()
          .server(() => ({ router: { caseSensitive: false } }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: { ...DEFAULT_ROUTER_FLAGS, caseSensitive: false } }])
  })

  // Under a matcher of its own the flags say nothing of how a path is matched, so a plugin that keys on them refuses.
  it("reports no router flags under a matcher of the server's own", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication()
          .server(() => ({ matcher: (flags, strategies) => findMyWayMatcher(flags, strategies) }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: undefined }])
  })

  it("reports the Node application's router flags", async () => {
    expect(
      await serverSeen(seen =>
        createWebApplication({ adapter: node() })
          .server(() => ({ router: { caseSensitive: false } }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: { ...DEFAULT_ROUTER_FLAGS, caseSensitive: false } }])
  })
})
