import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from './adapter.js'
import { createWebApplication as createFetchApplication } from './application.js'
import { Router } from './core/routing/programmatic/programmatic.js'
import { createWebApplication } from './platform/fastify/application.js'
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
    const app = createWebApplication()
      .server(() => ({ factory: { bodyLimit: 8 } }))
      .server(() => ({ factory: undefined }))
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
