import { afterEach, describe, expect, it } from 'vitest'

import { HTTPPlugin, RouteInventory, type WebApplication } from '../../index.js'
import { createWebApplication } from '../../platform/fastify/index.js'

/**
 * A reader of the inventory sees every server's routes or none: a plugin that read it while servers were still being
 * built would report the application's routes as the few registered so far.
 */
describe('RouteInventory', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('refuses a read while servers are still being built', async () => {
    class ReadsTooEarly extends HTTPPlugin {
      register(context: Parameters<HTTPPlugin['register']>[0]): void {
        void context.container.get(RouteInventory).servers
      }
    }

    app = createWebApplication().with(() => new ReadsTooEarly()) as WebApplication

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_APPLICATION_NOT_READY' })
  })

  it('answers once the application has bootstrapped', async () => {
    app = createWebApplication() as WebApplication

    await app.bootstrap()

    expect(app.container.get(RouteInventory).servers.map(server => server.server)).toEqual([undefined])
  })
})
