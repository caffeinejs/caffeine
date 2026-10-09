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
import type { FastifyInstance, RouteOptions } from 'fastify'
import fp from 'fastify-plugin'
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

  // A client links a reported route to the server's, so a path has to be the URL the server registered.
  it('names each route by the URL its server registered it on, and leaves out what plugins add', async () => {
    const registered = new Set<string>()

    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .install(Ops('devtools', o => o.server(() => ({ listener })).with(devTools())))
      .server(() => ({ listener }))
      .with(() =>
        fp(
          async (instance: FastifyInstance) => {
            instance.addHook('onRoute', (route: RouteOptions) => {
              if (route.config?.$caffeine?.compiled !== undefined) {
                registered.add(route.url)
              }
            })
          },
          { name: 'route-probe' },
        ),
      )
      .with(healthProbes())
      .mount(
        newRouter('/').get('/', () => ({})),
        newRouter('/pets')
          .get('/', () => [])
          .get('/:id/', () => ({}))
          .group('/:id/toys', toys => toys.get('/', () => [])),
      ) as WebApplication

    const { groups } = await report()
    const reported = new Set(groups.flatMap(group => group.routes.map(route => route.path)))

    expect(reported).toEqual(registered)
    expect(reported.has('/livez')).toBe(false)
    expect([...reported].some(path => path.startsWith('/devtools'))).toBe(false)
  })
})
