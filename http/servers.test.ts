import { Byte } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from './adapter.js'
import { createWebApplication as createFetchApplication } from './application.js'
import { findMyWayMatcher } from './core/matcher/find_my_way.js'
import { DEFAULT_ROUTER_FLAGS } from './core/matcher/matcher.js'
import { Router } from './core/routing/programmatic/programmatic.js'
import { createWebApplication as createNodeApplication } from './platform/node/node.js'
import { HTTPPlugin } from './plugin.js'
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
    const app = createNodeApplication()
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
    const fetchApp = createFetchApplication()
      .hook('onRequest', () => void order.push('first'))
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ app: ops }: HTTPSetupContext): void {
              ops.hook('onRequest', () => void order.push('plugin'))
            }
          })(),
      )
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
})

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
    expect(await serverSeen(seen => createFetchApplication().basePath('/api').with(recorder(seen)))).toEqual([
      { basePath: '/api', router: DEFAULT_ROUTER_FLAGS },
    ])
  })

  it('reports an empty base path when the application set none', async () => {
    expect(await serverSeen(seen => createFetchApplication().with(recorder(seen)))).toEqual([
      { basePath: '', router: DEFAULT_ROUTER_FLAGS },
    ])
  })

  // A router's slot is shared by every server that serves it: it belongs to none.
  it("reports no server on a router's slot", async () => {
    expect(
      await serverSeen(seen =>
        createFetchApplication().mount(
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
        createNodeApplication()
          .basePath('/api')
          .listener('admin', l => l.with(recorder(seen))),
      ),
    ).toEqual([{ basePath: '', router: DEFAULT_ROUTER_FLAGS }])
  })

  it('reports the router flags .server(...) set', async () => {
    expect(
      await serverSeen(seen =>
        createFetchApplication()
          .server(() => ({ router: { caseSensitive: false } }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: { ...DEFAULT_ROUTER_FLAGS, caseSensitive: false } }])
  })

  // Under a matcher of its own the flags say nothing of how a path is matched, so a plugin that keys on them refuses.
  it("reports no router flags under a matcher of the server's own", async () => {
    expect(
      await serverSeen(seen =>
        createFetchApplication()
          .server(() => ({ matcher: (flags, strategies) => findMyWayMatcher(flags, strategies) }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: undefined }])
  })

  it("reports the Node application's router flags", async () => {
    expect(
      await serverSeen(seen =>
        createNodeApplication()
          .server(() => ({ router: { caseSensitive: false } }))
          .with(recorder(seen)),
      ),
    ).toEqual([{ basePath: '', router: { ...DEFAULT_ROUTER_FLAGS, caseSensitive: false } }])
  })
})
