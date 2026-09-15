import fastify from 'fastify'
import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'

import {
  Controller,
  ErrHTTPNotFound,
  Get,
  createWebApplication,
  deriveServerOwnedPaths,
  fastifyAdapterFactory,
  isServerOwned,
} from '../index.js'
import type { Route, RouteGroup } from '../route.js'

@Controller('/pets')
class PetsController {
  @Get('/:id')
  byID(): unknown {
    throw new ErrHTTPNotFound('Pet not found')
  }

  @Get('/ok')
  ok(): unknown {
    return { ok: true }
  }
}
void [PetsController]

describe('unmatched routes', () => {
  it('renders the same envelope as a 404 a handler threw', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    await app.ready()

    const thrown = (await (await app.fetch('/pets/42')).json()) as Record<string, unknown>
    const unmatched = (await (await app.fetch('/no-such-route')).json()) as Record<string, unknown>

    // Same keys, same values — only the detail differs.
    expect(Object.keys(unmatched).sort()).toEqual(Object.keys(thrown).sort())
    expect(unmatched.statusCode).toBe(404)
    expect(unmatched.error).toBe('Not Found')
    expect(unmatched.code).toBe('ERR_HTTP_NOT_FOUND')
    expect(unmatched.message).toContain('/no-such-route')

    await app.close()
  })

  // The default is installed after every plugin, so a plugin that took the handler is not displaced by it.
  it('lets a plugin take the not-found handler, with the request context populated', async () => {
    let seenURL: string | undefined

    const shell = fp(async instance => {
      instance.setNotFoundHandler(async (req, reply) => {
        // Would throw if httpContext were absent.
        seenURL = req.httpContext.req.url
        return reply.code(200).type('text/html').send('<p>shell</p>')
      })
    })

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(() => shell)
      .build()
    await app.ready()

    const res = await app.fetch('/client/route?a=b')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>shell</p>')
    expect(seenURL).toBe('/client/route?a=b')

    await app.close()
  })

  it('renders a miss thrown from a plugin handler through the error pipeline', async () => {
    const partial = fp(async instance => {
      instance.setNotFoundHandler(async req => {
        throw new ErrHTTPNotFound(`Route ${req.method}:${req.url} not found`)
      })
    })

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(() => partial)
      .build()
    await app.ready()

    const res = await app.fetch('/nope')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'ERR_HTTP_NOT_FOUND' })

    await app.close()
  })

  it('keeps a not-found handler set on a Fastify instance the caller brought', async () => {
    const server = fastify({ logger: false })
    server.setNotFoundHandler((_req, reply) => {
      void reply.code(418).send({ mine: true })
    })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const res = await app.fetch('/nope')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ mine: true })

    await app.close()
  })
})

describe('deriveServerOwnedPaths', () => {
  const route = (path: string): Route<any> => ({ path }) as Route<any>
  const router = (path: string, routes: string[], prefix?: string): RouteGroup<any> =>
    ({ path, prefix, routes: routes.map(route) }) as RouteGroup<any>

  it('takes the controller base, so a sibling miss stays owned', () => {
    // `@Controller('/api')` with only `@Get('/')` still owns all of /api — otherwise /api/typo escapes.
    expect(deriveServerOwnedPaths([router('/api', ['/'])])).toEqual(['/api'])
  })

  it('includes the @Prefix', () => {
    expect(deriveServerOwnedPaths([router('/users', ['/list'], '/v1')])).toEqual(['/v1/users'])
  })

  it('truncates at the first dynamic segment', () => {
    expect(deriveServerOwnedPaths([router('/users/:id/photos', ['/'])])).toEqual(['/users'])
  })

  it('falls back to route paths for a controller mounted at the root', () => {
    expect(deriveServerOwnedPaths([router('/', ['/health', '/metrics'])])).toEqual(['/health', '/metrics'])
  })

  it('includes health probe paths', () => {
    expect(deriveServerOwnedPaths([], ['/livez', '/readyz'])).toEqual(['/livez', '/readyz'])
  })

  it('matches by segment, so /apifoo is not under /api', () => {
    const owned = ['/api']

    expect(isServerOwned(owned, '/api')).toBe(true)
    expect(isServerOwned(owned, '/api/pets')).toBe(true)
    expect(isServerOwned(owned, '/apifoo')).toBe(false)
    expect(isServerOwned(owned, '/apifoo/bar')).toBe(false)
  })
})
