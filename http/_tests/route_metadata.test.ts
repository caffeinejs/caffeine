import fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Controller,
  Get,
  RouteBuilder,
  Router,
  collectRouteGroups,
  createWebApplication,
  fastifyAdapterFactory,
  type HTTPPluginFactory,
  type Route,
  type RouteGroup,
  type WebApplication,
} from '../index.js'

/**
 * A plugin learns the application's routes the way any Fastify plugin does — from `onRoute` — and finds what
 * Caffeine compiled on `config.$caffeine`. There is no route table decorated on the server, so if the adapter
 * stops stamping the metadata, nothing else can hand it over and these fail.
 */

@Controller('/meta-controller')
class MetaController {
  @Get('/hello')
  hello() {
    return { ok: true }
  }
}
void [MetaController]

interface Seen {
  /** The route's methods joined with `|`: the adapter hands Fastify an array, its HEAD twin a string. */
  method: string
  url: string
  route: Route | undefined
  group: RouteGroup | undefined
}

/** Records every route registered after it, with whatever `$caffeine` metadata the route carries. */
function observer(seen: Seen[]): HTTPPluginFactory {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.addHook('onRoute', options => {
          seen.push({
            method: [options.method].flat().join('|'),
            url: options.url,
            route: options.config?.$caffeine?.route,
            group: options.config?.$caffeine?.group,
          })
        })
      },
      { name: 'observer' },
    )
}

/** Adds one `$route` group and one route registered straight on Fastify. Installed after the observer. */
const lateAndRaw: HTTPPluginFactory = () => async (instance: FastifyInstance) => {
  instance.$route('late', router => {
    router.path('/meta-late').routes([
      new RouteBuilder()
        .method('GET')
        .path('/hello')
        .handle(() => ({ ok: true })),
    ])
  })
  instance.get('/meta-raw', async () => ({ ok: true }))
}

function routerWithOneRoute(): Router {
  const router = new Router('/meta-router')
  router.get('/hello').handler(() => ({ ok: true }))
  return router
}

describe('route metadata on config.$caffeine', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('reaches onRoute for decorated, programmatic and $route routes, and not for a raw Fastify route', async () => {
    const seen: Seen[] = []
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(observer(seen))
      .with(lateAndRaw)
      .mount(routerWithOneRoute()) as WebApplication
    await app.ready()

    const get = (url: string) => seen.find(s => s.url === url && s.method === 'GET')

    expect(get('/meta-controller/hello')?.group?.target).toBe(MetaController)
    expect(get('/meta-controller/hello')?.route?.name).toBe('hello')
    expect(get('/meta-router/hello')?.route?.path).toBe('/hello')
    expect(get('/meta-late/hello')?.group?.name).toBe('late')

    // A guard reads `Symbol.metadata` off the class that declared the group, so a group no class declared
    // carries none rather than a stand-in class it could read nothing from.
    expect(get('/meta-late/hello')?.group?.target).toBeUndefined()

    expect(get('/meta-raw')).toBeDefined()
    expect(get('/meta-raw')?.route).toBeUndefined()
  })

  it('hands the automatic HEAD twin of a GET route the same compiled route', async () => {
    const seen: Seen[] = []
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(observer(seen))
      .mount(routerWithOneRoute()) as WebApplication
    await app.ready()

    const twins = seen.filter(s => s.url === '/meta-router/hello')

    expect(twins.map(s => s.method)).toEqual(['GET', 'HEAD'])
    expect(twins[0].route).toBeDefined()
    expect(twins[1].route).toBe(twins[0].route)
  })

  it('collectRouteGroups regroups what registered and counts the HEAD twin once', async () => {
    let groups: RouteGroup[] = []
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(() =>
        fp(
          async (instance: FastifyInstance) => {
            const collect = collectRouteGroups(instance)
            instance.addHook('onReady', async () => {
              groups = collect()
            })
          },
          { name: 'collector' },
        ),
      )
      .with(lateAndRaw)
      .mount(routerWithOneRoute()) as WebApplication
    await app.ready()

    const late = groups.filter(group => group.name === 'late')

    expect(late).toHaveLength(1)
    expect(late[0].routes.map(route => route.path)).toEqual(['/hello'])
  })
})
