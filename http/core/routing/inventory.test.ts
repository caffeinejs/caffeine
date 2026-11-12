import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication as createFetchApplication } from '../../application.js'
import { HTTPPlugin, Router, RouteInventory, type Guard, type WebApplication } from '../../index.js'
import { createWebApplication } from '../../platform/fastify/index.js'
import type { FetchAdapterTypes } from '../server/adapter.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any, any>
type FetchApp = WebApplication<FetchAdapterTypes, any, any, any>

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

// The fetch application serves no gate and no cross-origin protection, and refuses a route that needs either: its
// records say so rather than borrowing what the Fastify application would report.
describe('routeRecord on the fetch application', () => {
  let app: FetchApp | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  class TenantGuard implements Guard {
    guard(): boolean {
      return true
    }
  }

  async function records(router: AnyRouter) {
    app = createFetchApplication().mount(router)
    app.container.bind(TenantGuard, t => t.toSelf())
    await app.bootstrap()
    return app.container.get(RouteInventory).servers[0].routes
  }

  it('records a GET route with its HEAD twin as one record', async () => {
    const [record] = await records(new Router('/pets').get('/').handler(() => []))

    expect(record.methods).toEqual(['GET', 'HEAD'])
    expect(record.url).toBe('/pets')
  })

  it('records produces, status, timeout and guards', async () => {
    const [record] = await records(
      new Router('/reports')
        .guards([TenantGuard])
        .post('/')
        .produces('text/csv')
        .status(201)
        .timeout(5 * Second)
        .handler(() => 'id'),
    )

    expect(record).toMatchObject({ produces: 'text/csv', status: 201, timeout: 5 * Second })
    expect(record.security.guards).toEqual(['TenantGuard'])
  })

  it('reports no gate, no authorization and an uncovered POST', async () => {
    const [record] = await records(new Router('/orders').post('/').handler(() => 'id'))

    expect(record.security.authentication.gate).toBe(undefined)
    expect(record.security.authorization.protected).toBe(false)
    expect(record.security.csrf).toBe('uncovered')
  })
})
