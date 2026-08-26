import { describe, expect, it } from 'vitest'
import fastify from 'fastify'
import {
  Controller,
  ErrHTTPNotFound,
  Get,
  NotFoundFallback,
  createWebApplication,
  deriveServerOwnedPaths,
  fastifyAdapterFactory,
  isServerOwned,
} from '../index.js'
import type { NotFoundContext } from '../index.js'
import type { Route, Router } from '../route.js'

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

    const thrown = await (await app.fetch('/pets/42')).json() as Record<string, unknown>
    const unmatched = await (await app.fetch('/no-such-route')).json() as Record<string, unknown>

    // Same keys, same values — only the detail differs.
    expect(Object.keys(unmatched).sort()).toEqual(Object.keys(thrown).sort())
    expect(unmatched.statusCode).toBe(404)
    expect(unmatched.error).toBe('Not Found')
    expect(unmatched.code).toBe('ERR_HTTP_NOT_FOUND')
    expect(unmatched.message).toContain('/no-such-route')

    await app.close()
  })

  it('populates the request context inside the not-found handler', async () => {
    let seenPath: string | undefined

    class RecordingFallback extends NotFoundFallback {
      readonly name = 'recording'

      handle(ctx: NotFoundContext): boolean {
        // Would throw if httpContext were absent.
        seenPath = ctx.http.req.url
        return false
      }
    }

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    app.container.bind(RecordingFallback).toClass(RecordingFallback).extends(NotFoundFallback)
    await app.ready()

    await app.fetch('/nope?q=1')

    expect(seenPath).toBe('/nope?q=1')

    await app.close()
  })

  it('lets a fallback answer, and strips the query from the path it sees', async () => {
    class ShellFallback extends NotFoundFallback {
      readonly name = 'shell'

      handle(ctx: NotFoundContext): boolean {
        ctx.http.status(200).header('content-type', 'text/html').body(`<p>${ctx.path}</p>`)
        return true
      }
    }

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    app.container.bind(ShellFallback).toClass(ShellFallback).extends(NotFoundFallback)
    await app.ready()

    const res = await app.fetch('/client/route?a=b')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>/client/route</p>')

    await app.close()
  })
})

describe('deriveServerOwnedPaths', () => {
  const route = (path: string): Route<any> => ({ path }) as Route<any>
  const router = (path: string, routes: string[], prefix?: string): Router<any> =>
    ({ path, prefix, routes: routes.map(route) }) as Router<any>

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
