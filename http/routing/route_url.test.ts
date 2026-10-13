import type { FastifyInstance, RouteOptions } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../application.js'
import { newRouter } from './programmatic/new_router.js'
import { routeURL } from './route_url.js'

// Code that reads the route table instead of Fastify's names a route by `routeURL`, so whatever shape a group path,
// a route path and a prefix take, it has to be the URL the adapter registered.
describe('routeURL', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('names the URL the adapter registered each compiled route on', async () => {
    const pairs: Array<[named: string, registered: string]> = []

    app = createWebApplication()
      // Mounts a prefixed router and returns the probe: a factory may do both.
      .with(({ app: application }) => {
        application.mount(
          newRouter('/items')
            .with(group => {
              group.prefix('/v1')
            })
            .post('/', () => ({})),
        )

        return fp(
          async (instance: FastifyInstance) => {
            instance.addHook('onRoute', (route: RouteOptions) => {
              const compiled = route.config?.$caffeine?.compiled
              if (compiled !== undefined) {
                pairs.push([routeURL(compiled.group.prefix, compiled.group.path, compiled.route.path), route.url])
              }
            })
          },
          { name: 'route-url-probe' },
        )
      })
      .mount(
        newRouter('/').get('/', () => ({})),
        newRouter('/pets')
          .get('/', () => ({}))
          .get('/:id', () => ({}))
          .get('/x/', () => ({})),
      ) as WebApplication

    await app.bootstrap()

    expect(pairs.map(([, registered]) => registered)).toEqual(
      expect.arrayContaining(['/', '/pets', '/pets/:id', '/pets/x', '/v1/items']),
    )

    for (const [named, registered] of pairs) {
      expect(named).toBe(registered)
    }
  })
})
