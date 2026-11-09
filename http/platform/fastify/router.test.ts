import Fastify, { type FastifyPluginAsync, type FastifyServerOptions } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../../core/error/common.js'
import type { WebApplication } from '../../index.js'
import { createWebApplication } from './index.js'
import { hasRouteAt, routerFlagsOf } from './router.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function flagsOf(factory: FastifyServerOptions) {
  app = createWebApplication().server(() => ({ factory })) as WebApplication
  await app.bootstrap()

  return routerFlagsOf(app.instance)
}

describe('routerFlagsOf', () => {
  // A plugin that matches paths as the router does reads these: one flag off is a path it matches differently.
  it("answers the router's defaults on a server that sets none", async () => {
    expect(await flagsOf({})).toEqual({
      caseSensitive: true,
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      useSemicolonDelimiter: false,
    })
  })

  // `initialConfig` reports `useSemicolonDelimiter: false` under `routerOptions` here, while the router reads `;`.
  it('keeps a top-level flag that routerOptions leaves out', async () => {
    const flags = await flagsOf({ useSemicolonDelimiter: true, routerOptions: { caseSensitive: false } })

    expect(flags.useSemicolonDelimiter).toBe(true)
    expect(flags.caseSensitive).toBe(false)
  })

  it('takes a flag routerOptions sets over the top-level one', async () => {
    const flags = await flagsOf({ ignoreDuplicateSlashes: true, routerOptions: { ignoreDuplicateSlashes: false } })

    expect(flags.ignoreDuplicateSlashes).toBe(false)
  })
})

describe('hasRouteAt', () => {
  /** What a plugin registered after `earlier` finds at each of `asked`. */
  async function lookups(earlier: FastifyPluginAsync, asked: readonly [string, string][], factory = {}) {
    const found: boolean[] = []
    const later: FastifyPluginAsync = async instance => {
      found.push(...asked.map(([method, path]) => hasRouteAt(instance, method, path)))
    }
    app = createWebApplication()
      .server(() => ({ factory }))
      .with(() => fp(earlier, { name: 'earlier' }))
      .with(() => fp(later, { name: 'later' })) as WebApplication
    await app.bootstrap()

    return found
  }

  // `hasRoute` asks for the exact constraints, so a plugin refusing the URL would miss this route.
  it('finds a route registered before, whatever its constraints, by its method', async () => {
    const earlier: FastifyPluginAsync = async instance => {
      instance.get('/report', { constraints: { version: '2.0.0' } }, async () => 'v2')
      instance.route({ method: ['PUT', 'POST'], url: '/form', handler: async () => 'sent' })
    }

    expect(
      await lookups(earlier, [
        ['GET', '/report'],
        ['POST', '/report'],
        ['GET', '/other'],
        ['POST', '/form'],
      ]),
    ).toEqual([true, false, false, true])
  })

  it('compares paths as the router matches them', async () => {
    const earlier: FastifyPluginAsync = async instance => {
      instance.get('/Web//Report/', async () => 'report')
    }
    const flags = { routerOptions: { caseSensitive: false, ignoreDuplicateSlashes: true, ignoreTrailingSlash: true } }

    expect(await lookups(earlier, [['GET', '/web/report']], flags)).toEqual([true])
  })

  // Once ready, the record is gone: an answer then would say no route where there is one.
  it('refuses to answer once the server is ready', async () => {
    const earlier: FastifyPluginAsync = async instance => {
      instance.get('/report', async () => 'report')
    }
    await lookups(earlier, [])

    expect(() => hasRouteAt(app!.instance, 'GET', '/report')).toThrow(ErrConfiguration)
  })

  // Its options are Fastify's alone to know: an answer would be a guess.
  it('refuses a server the adapter did not build', async () => {
    const server = Fastify()

    try {
      expect(() => hasRouteAt(server, 'GET', '/')).toThrow(ErrConfiguration)
      expect(() => routerFlagsOf(server)).toThrow(ErrConfiguration)
    } finally {
      await server.close()
    }
  })
})
