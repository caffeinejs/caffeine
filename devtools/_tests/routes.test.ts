import { CaffeineIoC } from '@caffeinejs/di'
import {
  Authentication,
  Ops,
  authentication,
  bindTo,
  createWebApplication,
  healthProbes,
  newRouter,
  type WebApplication,
} from '@caffeinejs/http'
import type { RouteOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools, type DevToolsRoute, type DevToolsRoutesReport } from '../index.js'
import { get, listener } from './fixtures.js'

describe('the routes slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function report(): Promise<DevToolsRoutesReport> {
    await app!.bootstrap()
    return (await (await get(app!, '/devtools/routes')).json()) as DevToolsRoutesReport
  }

  function find(routesReport: DevToolsRoutesReport, path: string): DevToolsRoute | undefined {
    return routesReport.groups.flatMap(group => group.routes).find(route => route.path === path)
  }

  // DevTools answers on its own server, and still reports what the application's own and every other server serve.
  it('reports the routers of every server, each group naming the ops server it is bound to', async () => {
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .install(Ops('devtools', o => o.server(() => ({ listener })).with(devTools())))
      .server(() => ({ listener }))
      .mount(
        newRouter('/pets')
          .get('/', () => [])
          .get('/:id', () => ({})),
        newRouter('/jobs')
          .with(bindTo('admin'))
          .post('/', () => ({})),
      ) as WebApplication

    const { groups } = await report()

    const pets = groups.find(group => group.routes.some(route => route.path === '/pets'))
    const jobs = groups.find(group => group.routes.some(route => route.path === '/jobs'))

    expect(pets?.server).toBeUndefined()
    expect(pets?.routes.map(route => [route.methods, route.path])).toEqual([
      [['GET'], '/pets'],
      [['GET'], '/pets/:id'],
    ])
    expect(jobs?.server).toBe('admin')
    expect(jobs?.routes.map(route => [route.methods, route.path])).toEqual([[['POST'], '/jobs']])
  })

  it('reports what each route requires, with the schemes that authenticate it', async () => {
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .install(Authentication(a => a.addBasic('Basic', b => b.validate(() => null))))
      .install(Ops('devtools', o => o.server(() => ({ listener })).with(devTools(d => d.public()))))
      .server(() => ({ listener }))
      .with(authentication())
      .mount(
        newRouter('/admin')
          .authorize({ roles: ['admin'] })
          .authorize({ roles: ['auditor', 'owner'] })
          .get('/', () => ({})),
        newRouter('/open').get('/', () => ({})),
      ) as WebApplication

    const routesReport = await report()

    expect(find(routesReport, '/admin')?.authorization).toEqual({
      hasProtection: true,
      allowAnonymous: false,
      defaultPolicy: false,
      policies: [],
      roles: [['admin'], ['auditor', 'owner']],
      schemes: ['Basic'],
    })
    expect(find(routesReport, '/open')?.authorization).toMatchObject({ hasProtection: false, roles: [] })
  })

  // A client links a reported route to the server's, so a path has to be the URL the server registered. DevTools'
  // own routes are mounted like any router, so they are listed; a route a plugin registers straight on a server is not.
  it("names each route by the URL its server registered it on, DevTools' own included, and leaves out raw routes", async () => {
    const registered = new Set<string>()

    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .install(Ops('devtools', o => o.server(() => ({ listener })).with(devTools())))
      .server(() => ({ listener }))
      .serverCallback((_context, instance) => {
        instance.addHook('onRoute', (route: RouteOptions) => {
          if (route.config?.$caffeine?.compiled !== undefined) {
            registered.add(route.url)
          }
        })
      })
      .with(healthProbes())
      .mount(
        newRouter('/').get('/', () => ({})),
        newRouter('/pets')
          .get('/', () => [])
          .get('/:id/', () => ({}))
          .group('/:id/toys', toys => toys.get('/', () => [])),
      ) as WebApplication

    const { groups } = await report()
    const pathsOn = (server: string | undefined) =>
      groups.filter(group => group.server === server).flatMap(group => group.routes.map(route => route.path))

    expect(new Set(pathsOn(undefined))).toEqual(registered)
    expect(pathsOn(undefined)).not.toContain('/livez')
    expect(pathsOn('devtools')).toEqual([
      '/devtools',
      '/devtools/bindings',
      '/devtools/graph',
      '/devtools/routes',
      '/devtools/health',
      '/devtools/info',
      '/devtools/configuration',
    ])
  })
})
