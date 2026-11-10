import Fastify, { type FastifyPluginAsync, type FastifyServerOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../../core/error/common.js'
import type { WebApplication } from '../../index.js'
import { createWebApplication, newRouter } from './index.js'
import { routerFlagsOf, starParameterRefusal } from './router.js'

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

  // Its options are Fastify's alone to know: an answer would be a guess.
  it('refuses a server the adapter did not build', async () => {
    const server = Fastify()

    try {
      expect(() => routerFlagsOf(server)).toThrow(ErrConfiguration)
    } finally {
      await server.close()
    }
  })
})

describe('a route with a parameter named *', () => {
  async function bootstrapWith(url: string) {
    app = createWebApplication().mount(newRouter().get(url, () => 'answer')) as WebApplication

    return app.bootstrap().catch((err: unknown) => err)
  }

  // find-my-way gives such a parameter the wildcard's name: whoever reads params['*'] could not tell the two apart.
  it('fails start-up, naming the route', async () => {
    const err = await bootstrapWith('/assets/:*')

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message.split('\n')[0]).toBe(
      'Cannot register "/assets/:*": a parameter named "*" reads as a wildcard, whose value has that name',
    )
  })

  it('fails start-up on one after another parameter in a segment', async () => {
    expect(await bootstrapWith('/a/:x-:*')).toBeInstanceOf(ErrConfiguration)
  })

  it('fails start-up on a terminal optional parameter named *', async () => {
    expect(await bootstrapWith('/a/:*?')).toBeInstanceOf(ErrConfiguration)
  })

  it('leaves a wildcard and a named parameter alone', async () => {
    expect(await bootstrapWith('/assets/:name/*')).toBe(undefined)
  })

  it.each(['*tail', 'name:*'])('serves a route with the distinct parameter name %s', async name => {
    const plugin: FastifyPluginAsync = async server => {
      server.get(`/assets/:${name}`, async request => (request.params as Record<string, string>)[name])
    }
    app = createWebApplication().with(() => plugin) as WebApplication
    await app.bootstrap()

    expect(await (await app.request('/assets/report.txt')).text()).toBe('report.txt')
  })

  it('refuses a wildcard parameter in the URL an application hook registers', async () => {
    const plugin: FastifyPluginAsync = async server => {
      server.addHook('onRoute', route => {
        route.url = '/assets/:*'
      })
      server.route({ method: ['GET', 'HEAD'], url: '/assets/:name', handler: async () => 'answer' })
    }
    app = createWebApplication().with(() => plugin) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow('Cannot register "/assets/:*"')
  })

  it('refuses an ambiguous parameter when a prefixed root also registers a slash alias', async () => {
    const plugin: FastifyPluginAsync = async server => {
      await server.register(
        async routes => {
          routes.addHook('onRoute', route => {
            route.url = '/assets/:*'
          })
          routes.route({ method: ['GET', 'HEAD'], url: '/', handler: async () => 'answer' })
        },
        { prefix: '/raw' },
      )
    }
    app = createWebApplication().with(() => plugin) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow('Cannot register "/assets/:*"')
  })

  it('refuses an ambiguous parameter in the generated alias when the hook gives the first route a safe URL', async () => {
    const plugin: FastifyPluginAsync = async server => {
      await server.register(
        async routes => {
          routes.addHook('onRoute', route => {
            route.url = '/safe'
          })
          routes.route({ method: ['GET', 'HEAD'], url: '/', handler: async () => 'answer' })
        },
        { prefix: '/assets/:*' },
      )
    }
    app = createWebApplication().with(() => plugin) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow('Cannot register "/assets/:*/"')
  })

  it.each(['/', ''])('validates only the URL a prefixed route at %j actually registers', async url => {
    const plugin: FastifyPluginAsync = async server => {
      await server.register(
        async routes => {
          routes.addHook('onRoute', route => {
            route.url = '/assets/:*'
            route.url = '/raw/'
            route.url = '/assets/:name'
          })
          routes.route({ method: ['GET', 'HEAD'], url, handler: async () => 'answer' })
        },
        { prefix: '/raw' },
      )
    }
    app = createWebApplication().with(() => plugin) as WebApplication
    await app.bootstrap()

    expect(await (await app.request('/assets/report.txt')).text()).toBe('answer')
  })

  // An escaped colon is text, and a parameter's regular expression is the parameter's, whatever it holds.
  it.each([['/a::*'], ['/files/:name(^[a-z]+:*$)'], ['/files/:name(^\\(:*\\)$)'], ['/files/:name(:*']])(
    'reads no parameter named * in %s',
    url => {
      expect(starParameterRefusal(url)).toBe(undefined)
    },
  )
})
